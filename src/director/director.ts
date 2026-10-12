import type { Config } from '../config.ts';
import { clean } from '../stt/clean.ts';
import { toSpokenForm } from '../filter/speech-filter.ts';
import { interpretApproval, isStopCommand } from './approval.ts';
import { interpretGuiCommand } from './gui-command.ts';
import { progressLine } from './progress.ts';
import type {
  AgentSession,
  AudioFrame,
  AudioInput,
  AudioOutput,
  OutputSink,
  PermissionRequest,
  SpeechFilter,
  Transcriber,
  TranscriptionStream,
  TurnDetector,
  Unsubscribe,
  Voice,
} from '../types.ts';

export type DirectorState =
  | 'LISTENING'
  | 'HEARING'
  | 'THINKING'
  | 'SPEAKING'
  | 'AWAITING_APPROVAL';

/**
 * Only the parts of the clock the Director actually uses. Injected so an
 * approval timeout can be tested in a microsecond instead of ten seconds.
 */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /**
   * The clock #turnDeadline is measured against. Must come from this same
   * abstraction, not a bare `Date.now()` — a fake-timer test suite advances
   * a virtual clock that `Date.now()` never sees, so any deadline math done
   * against the real clock would silently never fire under test.
   */
  now(): number;
}

export interface DirectorDeps {
  config: Config;
  audioIn: AudioInput;
  audioOut: AudioOutput;
  transcriber: Transcriber;
  turns: TurnDetector;
  agent: AgentSession;
  voice: Voice;
  filter: SpeechFilter;
  /** Runs the gui on/off toggle directly. See gui-command.ts for why it never goes through Claude. */
  runGui: (mode: 'on' | 'off') => Promise<string>;
  sinks?: OutputSink[];
  timers?: Timers;
  /** Where technical detail goes. The user hears a short line instead. */
  onError?: (message: string) => void;
  /**
   * Where the per-turn trace goes. Left undefined by default: this is a voice
   * app, not a log, and the failure this exists to prevent was a silent one,
   * not a noisy one. `cli.ts` wires it to `console.error` behind `AXA_DEBUG`.
   */
  debug?: (message: string) => void;
}

const systemTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  now: () => Date.now(),
};

const GAVE_UP = 'Va bene, lascio stare. Non ho sentito la risposta.';
const DIDNT_CATCH = 'Scusa, non ho capito. Non lo faccio.';
const AUDIO_TROUBLE = 'Ho un problema con l’audio, controlla il microfono.';
const TURN_FAILED = 'Scusa, qualcosa è andato storto. Riprova.';

/**
 * How far ahead of the speakers the answer is allowed to run.
 *
 * The device queue holds four seconds; TTS delivers a long answer far faster
 * than it can be spoken, so without a ceiling the queue overflows and the tail
 * of the answer is dropped mid-word. Half the queue leaves room for the jitter
 * of a network voice while keeping a barge-in's flush cheap.
 */
const PLAYBACK_HIGH_WATER_MS = 2000;
const PLAYBACK_POLL_MS = 50;

/**
 * Assumed speaking rate used only to decide whether a fed-but-unconfirmed
 * sentence's audio has had *enough* time to be rendered — never a measured
 * figure, because none exists: `Voice` hands back a flat `AudioFrame` stream
 * with no sentence-to-audio boundary in it (see `#confirmSpoken`'s own doc
 * comment, and `#heardPrefix`'s, which makes the same character-proportional
 * approximation for the same reason). Roughly the pace of natural speech
 * (the same figure `tests/director/fakes.ts`'s `FakeVoice` renders at, not a
 * coincidence — a sentence that has genuinely finished rendering at that pace
 * must still be recognised as fully spoken, or a resumed turn repeats audio
 * the user already heard, which is exactly as wrong as skipping unheard
 * audio).
 *
 * The safety this whole mechanism needs — never mistake a sentence still
 * in flight for one that finished — does not come from padding this
 * constant above the real rate: the real rate is not known in production
 * and padding it would just reintroduce the opposite bug (a fully-rendered
 * sentence judged unconfirmed, and repeated). It comes from
 * `#confirmSpoken` only ever promoting a sentence once its *entire*
 * estimated duration fits inside `renderedMs` — never partial credit for a
 * sentence still playing — so a rate that runs a little optimistic merely
 * delays confirmation by one more poll, it never confirms early. Not
 * self-calibrated against real per-turn timing on purpose — one more thing
 * that can be measured wrong; simplicity was chosen over precision.
 */
const CONSERVATIVE_MS_PER_CHAR = 70;

/**
 * How often to say something while a tool runs. Long enough not to nag, short
 * enough that the user never wonders whether the thing is still alive.
 */
const PROGRESS_EVERY_MS = 3000;

/**
 * How many words a final transcript needs before its detected language is
 * trusted enough to switch the conversation's language (spec: 2026-09-27, "we
 * use turbo model so we can detect [a language switch mid-conversation]").
 *
 * The inverse framing of approval.ts's `MAX_WORDS = 4` ("short enough to be a
 * whole yes/no answer, not a sentence"): here the question is "long enough to
 * be more than a stray word whisper's per-utterance auto-detect could easily
 * get wrong" — a 1-2 word utterance ("sì", "ok", "ciao") is not enough signal
 * to reliably detect language at all, turbo or not, and a wrong guess there
 * does not just cost one misheard word, it silently re-routes the rest of the
 * conversation's TTS voice AND the agent's own reply language. Set above
 * approval.ts's threshold on purpose: this switch is much more consequential
 * and much less correctable (nothing here asks the user to confirm it) than
 * approval.ts's yes/no gate is.
 */
const MIN_WORDS_FOR_LANGUAGE_SWITCH = 5;

/**
 * Below this, whisper-server's own reported confidence for the detected
 * language (0-1) is not trusted even when the word-count gate above passes.
 *
 * Empirically verified (2026-09-27, against the installed whisper.cpp 1.9.2
 * `whisper-server` binary, run live against real debug-audio fixtures — see
 * transcriber.ts's `parseVerboseJson` doc comment) that a `verbose_json`
 * response DOES expose a numeric confidence for its language guess, contrary
 * to the "most whisper.cpp server builds don't" assumption this constant
 * would otherwise have to fall back to — a near-silent/hallucination-prone
 * clip was observed landing a language guess at 0.259 confidence, well below
 * a real, live, unambiguous-language utterance's ~0.8+. This is deliberately
 * ALSO gated on word count, not confidence alone: confidence is not
 * guaranteed to be present on every whisper-server build (`confidence` is
 * `undefined`, not 0, when the server's response omits it — see
 * TranscriptionStream.onFinal's doc comment), so `#maybeSwitchLanguage` below
 * treats `undefined` as "no signal" and falls back to word count alone rather
 * than refusing to ever switch on an older/different server build.
 */
const MIN_LANGUAGE_CONFIDENCE = 0.6;

/**
 * Languages `#maybeSwitchLanguage` is willing to switch TO — every language
 * this product's voice actually supports, and nothing else (spec: 2026-09-27,
 * mid-conversation language switch was asked for between Italian and
 * English specifically). Without this, ANY code whisper-server reports
 * (including a rare/misdetected one on a noisy clip that happens to clear
 * both thresholds above) gets accepted, `#language` becomes sticky at that
 * value, and Cartesia's sonic-3 voice then rejects/closes the socket on
 * every subsequent `synthesize()` call using it — breaking every following
 * turn until the user happens to say 5+ clean words in a supported language
 * again. Checked before the switch is ever considered, not just before
 * assigning `#language`, so an unsupported guess leaves the sticky language
 * exactly where it was, same as any other rejected switch.
 */
const SWITCHABLE_LANGUAGES = new Set(['it', 'en']);

async function only(text: string): Promise<AsyncIterable<string>> {
  return (async function* () {
    yield text;
  })();
}

/**
 * Wraps a sentence generator with a single, persistent pump, and returns a
 * factory that hands out fresh views onto its buffered output.
 *
 * Why this exists (found while implementing the SPEAKING-onset redesign,
 * spec 2026-09-27): a SPEAKING-onset mute pauses `#play()` without ending the
 * turn, and — if the recapture is not a stop command — `#run()`'s loop calls
 * `#play()` again on the SAME sentence stream. But `Voice.synthesize()` (see
 * `cartesia.ts`) drives its own `for await (const sentence of text)` loop in a
 * detached background task (`feeding`) that is not part of the generator's own
 * suspension points: aborting the signal makes `synthesize()` return promptly,
 * but does NOT cancel a `.next()` call `feeding` already has in flight on the
 * raw sentence generator. Handing that same raw generator to a *second*
 * `synthesize()` call would start a second concurrent `.next()` puller on it;
 * per spec, concurrent `.next()` calls on one generator queue and resolve in
 * the order they were issued — so the first sentence produced after resume
 * would be delivered to the abandoned (zombie) `feeding`, which silently
 * discards it (its own `signal.aborted`/`done` are already true), while the
 * new call's `feeding` is left waiting for the sentence *after* that one —
 * or, if that lost sentence was the turn's last, waiting forever, hanging the
 * resumed turn.
 *
 * The fix is to make sure only one consumer ever calls `.next()` on the raw
 * generator: the pump below, started once and never restarted. Everything
 * downstream (each `#play()` call) reads from a buffer the pump fills, so an
 * abandoned reader simply stops being read — nothing it might have been
 * mid-pull on is lost, because it was never the one pulling.
 *
 * Each call to the returned factory hands out its own independent view, with
 * its own read cursor into `buffer` (starting at `from`, not always at 0) and
 * its own generation number. Two things that fixes, found in code review
 * against this exact redesign:
 *
 * (a) The cursor used to be a single index shared by every view. An
 * abandoned reader left suspended in the `await` below, still holding the
 * (also shared) `wake` slot, would be woken by the NEXT sentence the pump
 * buffers and — since it reads the same shared `index` — would yield that
 * sentence to its own (already-superseded) consumer, silently stealing it
 * from whatever fresh view a resume just created. `wake` is now a broadcast
 * to every suspended view, and `generation` makes a superseded view check,
 * on every wake, whether it is still the current one before it ever reads
 * `buffer` — if not, it returns instead of yielding, so it can never resume
 * consuming again even if handed another wake-up later.
 *
 * (b) `from` lets the caller anchor a resumed view's cursor on what was
 * actually RENDERED, not merely handed to a live `voice.synthesize()` call
 * (Director tracks the fed side via `#fed`, see `#trackFed`, and only
 * promotes a sentence into the confirmed `#spoken.length` used here once
 * `#confirmSpoken` decides the render side can account for it). That
 * distinction matters because a real `Voice`'s `feeding` task (cartesia.ts)
 * pulls arbitrarily far ahead of what it has actually turned into playable
 * audio — unbounded, not just one sentence ahead — so if the resume cursor
 * trusted that eager pull directly, sentences fed into a socket that then
 * closed on abort — never actually rendered — would be skipped on resume
 * and silently never spoken. Found in code review (2026-09-27) against this
 * exact redesign: the fed/confirmed split below is what that review asked
 * for after the first fix pass conflated the two.
 */
function relay(source: AsyncIterable<string>): (from?: number) => AsyncGenerator<string> {
  const buffer: string[] = [];
  let done = false;
  let failure: unknown;
  let generation = 0;
  const waiters = new Set<() => void>();
  const notify = (): void => {
    for (const wake of waiters) wake();
    waiters.clear();
  };

  // The one and only consumer of `source`, for the lifetime of the turn —
  // started immediately, independent of whether anything is reading the
  // buffer yet or ever again in between pauses.
  void (async () => {
    try {
      for await (const item of source) {
        buffer.push(item);
        notify();
      }
    } catch (err) {
      failure = err;
    } finally {
      done = true;
      notify();
    }
  })();

  return function stream(from = 0): AsyncGenerator<string> {
    // Superseding a view (every call here after the first) must retire the
    // PREVIOUS one immediately: see (a) above.
    const myGeneration = ++generation;
    let index = from;
    return (async function* () {
      for (;;) {
        if (myGeneration !== generation) return;
        while (index < buffer.length) {
          if (myGeneration !== generation) return;
          yield buffer[index++]!;
        }
        if (done) {
          if (failure) throw failure;
          return;
        }
        // Broadcast, not a single slot: every currently-suspended view (a
        // live one waiting for the next sentence, and possibly a stale one
        // that has not yet noticed it was superseded) must be woken, or
        // whichever one does NOT get the single wake-up starves forever.
        await new Promise<void>((resolve) => {
          waiters.add(resolve);
        });
      }
    })();
  };
}

/**
 * The turn loop. Every other component is a leaf that knows one thing; this is
 * the only place that knows what is happening overall, which is why it is also
 * the only place that can decide to fill a silence, cut a sentence short, or
 * ask before writing a file.
 */
export class Director {
  readonly #deps: DirectorDeps;
  readonly #timers: Timers;
  readonly #unsubscribe: Unsubscribe[] = [];

  #state: DirectorState = 'LISTENING';
  #stream: TranscriptionStream | undefined;
  #lastPartial: string | null = null;
  #lastFinal = '';

  /**
   * The conversation's current spoken language (ISO 639-1: 'it', 'en', ...),
   * starting at `config.stt.language`'s value ('it') exactly as before this
   * existed — the reversal (spec: 2026-09-27) is that it can now change mid-
   * conversation, not that the conversation starts anywhere else. Read by
   * `#play()` on every turn (propagated to `voice.synthesize()`) and updated
   * only by `#maybeSwitchLanguage()`, never written to directly elsewhere:
   * one place decides when a switch is trustworthy enough to act on (see
   * MIN_WORDS_FOR_LANGUAGE_SWITCH / MIN_LANGUAGE_CONFIDENCE), and every other
   * reader just gets whatever it last decided.
   */
  #language: string;

  /**
   * True whenever the turn detector reports the user speaking, independent of
   * `#state`. `#state` answers what the agent is doing; this answers whether
   * the user is being recorded — the two used to be the same question, which is
   * exactly what let a follow-up during THINKING look like a cancellation.
   */
  #capturing = false;
  /**
   * The state when the utterance now being recorded began, or null when nothing
   * is being recorded. `#onTurnEnd` routes by this, not by the state the
   * machine has since moved to: a follow-up that began in THINKING can land in
   * AWAITING_APPROVAL if a permission prompt arrived mid-sentence, and only
   * where capture BEGAN says whether it is a follow-up or the answer to that
   * prompt.
   */
  #capturingFrom: DirectorState | null = null;
  /** What the user said while THINKING, waiting to be folded into the next turn. */
  #queued: string[] = [];

  /**
   * Bumped whenever the current turn stops mattering — a new turn, a barge-in,
   * an abandoned approval. The pipeline is several async generators deep, so it
   * keeps running for a while after the decision to drop it; checking this
   * before every state change is what stops a dead turn from resurrecting.
   */
  #turnId = 0;
  #tts: AbortController | undefined;
  /** The line the Director itself is speaking, if any. One at a time. */
  #line: AbortController | undefined;
  /** Armed while a tool is running, re-armed after every line it speaks. */
  #progressTimer: unknown;
  /**
   * Armed for the whole turn, not just a tool call: progress narration covers
   * a slow tool, but nothing covered a stream that stops producing events
   * entirely (a genuinely hung network call inside the agent). Cleared on
   * every path out of `#run` — success, interrupt, stop-word — so it never
   * fires against a turn that already finished on its own.
   */
  #turnTimer: unknown;
  /**
   * The absolute wall-clock deadline for the current turn, set once in
   * `#run()`. `#armTurnTimer` re-arms against this deadline, not against a
   * fresh `turnTimeoutMs` window, specifically because approvals can re-arm
   * it more than once per turn (see `#onPermission`/`#answer`): a turn that
   * hits several sequential tool approvals must not get a brand-new 45s
   * budget on each one, or the "hard ceiling" documented on
   * `config.director.turnTimeoutMs` stops being a ceiling at all (spec:
   * 2026-09-27, a LinkedIn search that kept re-approving Bash calls ran for
   * ~20 minutes before the user gave up asking for its status).
   */
  #turnDeadline: number | undefined;
  /** When the current approval pause began, so #answer() can add the elapsed wait back onto #turnDeadline. */
  #approvalPauseStart: number | undefined;
  /**
   * How many tool calls are outstanding right now, this turn.
   *
   * Claude routinely fires tools in parallel — `session.ts` brackets each
   * content-block index with its own start/end — so a fast `Read` finishing
   * beside a slow `WebSearch` must not silence the narration the `WebSearch`
   * still needs. A count, not a set keyed by name: two calls to the same tool
   * (two `Read`s at once) would collide on one key, and the first `end` would
   * then stop narration for the one still running — the exact bug this
   * replaces, just triggered by a duplicate name instead of a different one.
   * Reset to 0 at the top of `#run`, same as `#asideMs`, so a tool whose `end`
   * never arrives — an interrupt, a crash — cannot wedge narration into the
   * next turn: nothing outside the dead turn's own generator ever reads it
   * again once that reset happens.
   */
  #toolsRunning = 0;

  /**
   * `#heardPrefix`'s text corpus: every sentence of this turn's answer whose
   * audio reached `audioOut` — was ENQUEUED on the device, which is all
   * `#confirmSpoken` can see — in `relay()`'s buffer order. Deliberately NOT
   * the resume cursor: `#waitForRoom` lets `#play` run up to
   * PLAYBACK_HIGH_WATER_MS ahead of the speakers, so on a mid-answer barge-in
   * the tail of this array is audio `flush()` then throws away unrendered.
   * Resuming from here would skip it — the user would hear a hole in the
   * middle of the answer. `#renderedCount` is the cursor; see its own doc
   * comment, `#fed`'s for the (larger, eager) superset both are drawn from,
   * and `#confirmSpoken`'s for how a sentence graduates from one to the other.
   */
  #spoken: string[] = [];
  /**
   * How many of `#fed`'s leading sentences the device has actually RENDERED —
   * played out of its queue, not merely been handed. This is `#run`'s resume
   * cursor (`nextSentenceStream(this.#renderedCount)`), and the one number
   * that decides what a barge-in resume re-speaks.
   *
   * A count, not an array, because the text is already in `#fed` at those same
   * indices, and it tracks `#fed`'s indexing exactly: `#fed` is truncated back
   * to this value at the top of every `#run` loop iteration, and the view
   * built there re-feeds those same sentences from relay's buffer in the same
   * order.
   *
   * Always `<= #spoken.length`: everything rendered was necessarily enqueued
   * first. The gap between them is precisely the audio a barge-in's `flush()`
   * discards — counted as heard for the interruption note (it left our hands;
   * `#heardPrefix` clamps it by `heardMs` anyway) but re-spoken on resume.
   */
  #renderedCount = 0;
  /**
   * Every sentence handed to the CURRENT `voice.synthesize()` call so far,
   * in order — the raw, eager feed side, populated by `#trackFed` the
   * instant a Voice's own feed (Cartesia's `feeding`, cartesia.ts:277-286)
   * pulls the next one. Deliberately NOT what the resume cursor or
   * `#heardPrefix` read: a real Voice's feed drains this arbitrarily far
   * ahead of what has actually been rendered (unbounded, not bounded to one
   * sentence — see `relay()`'s doc comment (b)), so `#fed` on its own tells
   * you nothing about what the user actually heard. `#confirmSpoken` is the
   * only thing that reads it, to decide how much of it to promote into
   * `#spoken`.
   *
   * Truncated back to `#renderedCount` at the top of every `#run` loop
   * iteration (a fresh `#play()` attempt), not merely appended to: a
   * previous attempt's unrendered tail was already fed once and, on
   * resume, `nextSentenceStream(this.#renderedCount)` feeds those same
   * sentences again from relay's buffer — leaving the stale entries in
   * `#fed` would duplicate them and desync `#fed`'s order from relay's.
   */
  #fed: string[] = [];

  /**
   * Total audio ever handed to the speakers, counted the way the device counts
   * it: from the beginning, never reset. `flush()` answers in that same
   * timeline, so the two are only comparable if this one also never restarts.
   */
  #enqueuedMs = 0;
  /** Where in that timeline this turn's answer began. */
  #answerFromMs = 0;
  /**
   * Audio the Director spoke on its own behalf since this answer began.
   *
   * `#answerFromMs` alone only excludes lines spoken *before* the first answer
   * frame — an approval question. A line spoken while the answer is
   * already running, which is what narrating a tool call is, lands inside the
   * answer's stretch of the timeline and would otherwise inflate its measured
   * duration, skewing the prefix even though `#answerFromMs` never moved.
   */
  #asideMs = 0;
  /**
   * Where the aside sits in the `#enqueuedMs` timeline, as [start, end] spans.
   *
   * `#asideMs` is the total enqueued; this is its position, which is what lets
   * a barge-in's `heardMs` be split into "aside rendered" and "aside still
   * queued". A span is one contiguous burst — a single progress line — but a
   * turn can hold several, separated by answer frames, so a lone end position
   * would not say which frames belonged to the aside.
   */
  #asideSpans: Array<[number, number]> = [];
  /**
   * Whether `#play` has emitted the turn's first frame yet — for the whole
   * turn, not for a single `#play()` call. See `#run`'s own comment on why a
   * SPEAKING-onset mute must not reset `#answerFromMs`/`#asideMs`/
   * `#asideSpans` on every resume.
   */
  #answerStarted = false;

  /** What the user heard before cutting in, waiting for what they say next. */
  #pendingNote: string | undefined;

  /**
   * True from the instant a speech onset mutes a SPEAKING answer until
   * `#onTurnEnd` has decided, from the recapture's own final transcript,
   * whether that onset was an explicit stop or an ordinary follow-up.
   *
   * `#run`'s loop reads this to tell "the answer finished on its own" apart
   * from "the answer was merely paused mid-turn" — the turn itself (the
   * agent's own `send()` stream, any tool call or subagent Task still
   * running inside it) is untouched either way; only an explicit stop
   * command (isStopCommand) may go on to cancel it. See `#muteForBargeIn`'s
   * doc comment for why this exists instead of the old eager `#bargeIn()`
   * (spec: 2026-09-27, an AEC-suppressed echo mid-answer was wrongly treated
   * as "the user is interrupting" and killed a running LinkedIn search).
   */
  #pausedForBargeIn = false;
  /**
   * Resolved by `#onTurnEnd` once the stop-vs-follow-up decision above is
   * made — `undefined` whenever `#pausedForBargeIn` is false, since nothing
   * is waiting on it then. `#run`'s loop blocks on a fresh Promise stored
   * here while paused; resolving it (with `#turnId` unchanged) is what lets
   * the loop go on to resume speaking the very same turn.
   */
  #bargeInResume: (() => void) | undefined;
  /**
   * The `#heardPrefix` computed at the moment a SPEAKING onset muted the
   * answer, before it is known whether that onset will turn out to be a
   * stop or a follow-up. Consumed only on the stop path, as `#pendingNote`
   * for whatever the user says *next* (not for the stop word itself, which
   * is never dispatched as a question — see `#onTurnEnd`). Thrown away
   * unread on the follow-up path: nothing was actually cancelled, so there
   * is nothing to tell Claude it missed.
   */
  #bargeInHeard: string | undefined;
  /**
   * Resolves once `#muteForBargeIn`'s flush (and the accounting that reads
   * its result) has actually run. `#onTurnEnd` awaits it before consulting
   * `#bargeInHeard` — in practice the recapture's own round trip is far
   * slower than one flush, so this never actually blocks, but nothing
   * here should depend on that timing being coincidental.
   */
  #bargeInReady: Promise<void> | undefined;

  /**
   * True when the user has explicitly silenced the mic (spacebar in cli.ts).
   * A background tool call can run long enough that a nearby conversation not
   * meant for Axa gets treated as a follow-up — this is the escape hatch, and
   * it has to be instant: gating `#onFrame` before the turn detector ever sees
   * a frame, rather than after, so a muted room produces no onset at all.
   */
  #muted = false;

  #approval:
    | { resolve: (value: boolean) => void; from: DirectorState; timer: unknown }
    | undefined;

  constructor(deps: DirectorDeps) {
    this.#deps = deps;
    this.#timers = deps.timers ?? systemTimers;
    this.#language = deps.config.stt.language;
  }

  get state(): DirectorState {
    return this.#state;
  }

  get muted(): boolean {
    return this.#muted;
  }

  /**
   * Toggle the mic on/off. Muting cancels whatever utterance is mid-capture
   * rather than letting it finish — the whole point is an instant off switch,
   * not one that waits out a turn already in flight.
   */
  setMuted(muted: boolean): void {
    if (this.#muted === muted) return;
    this.#muted = muted;
    if (muted) {
      this.#capturing = false;
      this.#capturingFrom = null;
      // `#capturing = false` above only stops NEW frames from reaching the
      // current TranscriptionStream; it does not close the stream itself.
      // Whatever audio was already buffered mid-utterance (muting cancels a
      // capture rather than letting it finish, per this method's own doc
      // comment) stays sitting in that stream's buffer, unflushed. Worse,
      // with the real VadTurnDetector its own `#speaking` is left set too —
      // `#onFrame` returns before ever calling `turns.push()` while muted
      // (see its own comment), so the detector never sees the silence that
      // would otherwise end its turn normally. The very first frame it DOES
      // see after unmuting is then measured against a stale
      // `#lastSpeechAt`/`#prefixStableSince` from before the mute, so a
      // silent frame can immediately satisfy the silence+stability test and
      // fire a turnEnd for nothing — which `#onTurnEnd` correctly no-ops on
      // (nothing was ever captured post-unmute), but does NOT clean up the
      // stream, since it only calls `#takeFinal()` (close + reopen) on paths
      // that had something to take. Left alone, the NEXT real utterance's
      // `#onSpeechStart` pushes its audio onto that same stale, still-open
      // stream — the old buffered samples and the new utterance get
      // transcribed together as one. Closing and reopening here, discarding
      // whatever the stale stream's own final transcription comes back as
      // (it belongs to speech the user explicitly cut off by muting, not a
      // real answer), is what `#onTurnEnd`/`#takeFinal` already do on every
      // other path that ends a capture — this is muting's own equivalent.
      void this.#discardStream();
      if (this.#state === 'HEARING') this.#setState('LISTENING');
      // HEARING can be a barge-in pause waiting on `#onTurnEnd`'s
      // stop-vs-follow-up decision (see `#pausedForBargeIn`'s own comment).
      // Cutting capture off here, first, means `#onTurnEnd` never fires for
      // this utterance — a muted room drops every frame before the turn
      // detector ever sees it (`#onFrame`), so it can never reach a turnEnd
      // — and nothing else was ever going to resolve the pause. Left alone,
      // `#run`'s loop stays parked on `#bargeInResume` for the rest of
      // `turnTimeoutMs`, then speaks a spurious "something went wrong"
      // apology over a turn that was actually healthy throughout. Releasing
      // here is exactly what an ordinary non-stop recapture does (see
      // `#onTurnEnd`'s own branch): nothing was actually said, so there is
      // no interruption note either, and the answer just resumes.
      //
      // Guarded on AWAITING_APPROVAL for the same reason `#onTurnEnd`'s
      // resume branch is: `#onPermission` can move `#state` there
      // independently of this pause (it is driven by the SDK's own
      // `canUseTool` callback, not gated on `#pausedForBargeIn`) while the
      // mute is still outstanding. Clobbering it back to SPEAKING here would
      // strand the live `#approval` resolve/timer pair exactly as it would
      // in `#onTurnEnd` — and muting the mic mid-pause leaves the user with
      // no way to answer it at all, so the eventual `approvalTimeoutMs`
      // timeout and its GAVE_UP apology would be all the more misleading.
      if (this.#pausedForBargeIn && this.#state !== 'AWAITING_APPROVAL') {
        this.#setState('SPEAKING');
        this.#releaseBargeIn();
      }
    }
    void this.#say(muted ? 'Microfono disattivato.' : 'Microfono riattivato.');
  }

  /** No-op unless a `debug` dep was injected — never a bare `console.log` here. */
  #debug(message: string): void {
    this.#deps.debug?.(message);
  }

  /**
   * The single place `#state` changes, so the single place a transition can be
   * traced. A no-op transition (`approval.from` landing back on the state it
   * started from) is not worth a line — it tells Task 7 nothing it did not
   * already know.
   */
  #setState(next: DirectorState): void {
    if (next !== this.#state) this.#debug(`state: ${this.#state} -> ${next}`);
    this.#state = next;
  }

  async start(): Promise<void> {
    const { audioIn, turns, agent, voice } = this.#deps;

    voice.prewarm?.();
    this.#unsubscribe.push(
      audioIn.onFrame((frame) => this.#onFrame(frame)),
      audioIn.onError((message) => this.#abandon(message, AUDIO_TROUBLE)),
      turns.onSpeechStart(() => this.#onSpeechStart()),
      turns.onTurnEnd(() => void this.#onTurnEnd()),
    );
    agent.onPermissionRequest((req) => this.#onPermission(req));

    await this.#openStream();
    await audioIn.start();
    this.#setState('LISTENING');
  }

  async stop(): Promise<void> {
    for (const off of this.#unsubscribe.splice(0)) off();
    this.#turnId++;
    this.#tts?.abort();
    this.#stopProgress();
    this.#stopTurnTimer();
    this.#resolveApproval(false);
    this.#releaseBargeIn();
    // Nothing is coming back to drain this session's queue.
    this.#queued = [];

    const stream = this.#stream;
    this.#stream = undefined;
    await stream?.close(this.#language);
    await this.#deps.audioIn.stop();
    this.#deps.voice.close?.();
    this.#setState('LISTENING');
  }

  // ---------------------------------------------------------------- listening

  /**
   * A transcription stream is kept open at all times, but fed only while the
   * user is being heard. Opening it on speech onset would put the connection
   * setup on the critical path, and feeding it during silence would have
   * whisper transcribing an empty room every 350ms.
   */
  async #openStream(): Promise<void> {
    const stream = await this.#deps.transcriber.open();
    this.#lastPartial = null;
    this.#lastFinal = '';
    stream.onPartial((text) => {
      this.#lastPartial = text;
    });
    stream.onFinal((text, language, confidence) => {
      this.#lastFinal = text;
      this.#maybeSwitchLanguage(text, language, confidence);
    });
    this.#stream = stream;
  }

  /**
   * Sticky-language policy (spec: 2026-09-27). Only actually switches
   * `#language` when BOTH the utterance is substantial enough to trust
   * (MIN_WORDS_FOR_LANGUAGE_SWITCH) AND, when the server reports one, its
   * confidence clears MIN_LANGUAGE_CONFIDENCE — see both constants' doc
   * comments for why each threshold is where it is. A short reply ("sì",
   * "ok") or a low-confidence guess leaves `#language` exactly where it was;
   * this is what stops a single ambiguous word from flipping the whole
   * conversation's voice and reply language. A detected code outside
   * SWITCHABLE_LANGUAGES is rejected before either threshold is even
   * checked — see that constant's doc comment.
   */
  #maybeSwitchLanguage(text: string, language: string, confidence: number | undefined): void {
    if (!language || language === this.#language) return;
    if (!SWITCHABLE_LANGUAGES.has(language)) return;
    if (confidence !== undefined && confidence < MIN_LANGUAGE_CONFIDENCE) return;
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    if (words < MIN_WORDS_FOR_LANGUAGE_SWITCH) return;
    this.#debug(
      `language: switching ${this.#language} -> ${language} ` +
        `(words=${words}, confidence=${confidence ?? 'n/a'})`,
    );
    this.#language = language;
  }

  #onFrame(frame: AudioFrame): void {
    // Muted means invisible, not just unheard: the detector never even sees the
    // frame, so a muted room cannot produce a speech onset in the first place.
    if (this.#muted) return;
    // The detector first: it may turn this very frame into a speech onset, and
    // the frame that crossed the threshold is one whisper needs.
    //
    // `audioOut.isPlaying()`, not `#state === 'SPEAKING'`: an approval question,
    // a progress line and an apology all play through the same device outside
    // SPEAKING (THINKING, AWAITING_APPROVAL, LISTENING respectively), and each
    // is exactly as capable of producing a residual-echo false onset as the
    // answer itself is. Gating on `#state` would leave every one of those
    // unprotected.
    this.#deps.turns.push(frame, this.#lastPartial, this.#deps.audioOut.isPlaying());
    // Capture is now independent of `#state`. THINKING must be able to record
    // the user without ceasing to be THINKING: what they say is a follow-up,
    // not a cancellation. Gating on `#capturing` alone is still what keeps
    // whisper from transcribing an empty room during LISTENING.
    if (this.#capturing) this.#stream?.push(frame);
  }

  #onSpeechStart(): void {
    this.#capturing = true;
    // Record where the utterance began before any transition below moves it:
    // the routing at #onTurnEnd has to know whether this was a follow-up (from
    // THINKING), a barge-in (from SPEAKING), or an approval answer.
    this.#capturingFrom = this.#state;
    // Already listening: HEARING is mid-utterance, AWAITING_APPROVAL is waiting
    // for an answer. Neither is interrupted by the user starting to talk.
    if (this.#state === 'HEARING' || this.#state === 'AWAITING_APPROVAL') return;
    // THINKING is silent work: talking during it adds to the conversation
    // (spec §1/§2) instead of destroying it, so it stays THINKING — only
    // capture started. SPEAKING is the one state barge-in still applies to
    // (spec §6 line 411); LISTENING simply becomes HEARING, the ordinary start
    // of an utterance.
    if (this.#state === 'THINKING') return;

    const wasSpeaking = this.#state === 'SPEAKING';
    this.#setState('HEARING');
    if (wasSpeaking) this.#muteForBargeIn();
  }

  /**
   * Speech onset during SPEAKING: stop talking over the user, instantly —
   * but do NOT touch the agent turn yet. Whether this onset is the start of
   * an explicit "stop"/"basta" or just an echo, a cough, or an unrelated
   * follow-up remark is not knowable until the recaptured utterance's final
   * transcript comes back, in `#onTurnEnd`; only that later decision may
   * cancel the turn (bump `#turnId`, call `agent.interrupt()`). Muting is
   * split out from that decision on purpose (spec: 2026-09-27) — a real
   * incident had an AEC-suppressed residual echo of the Director's own voice
   * cross the onset threshold and get treated as "the user is interrupting",
   * killing a LinkedIn search that was still running in the background. See
   * `#onTurnEnd`'s `beganWhileWorking` branch, which now also covers
   * `capturingFrom === 'SPEAKING'`, for where that decision is actually made.
   *
   * Aborting `this.#tts` here (without bumping `#turnId`) is what silences
   * the speakers immediately: `#play`'s loop reads `signal.aborted` on its
   * very next check and returns 'paused' rather than 'finished' — see
   * `#play`'s own comment. `#run`'s loop then blocks on `#bargeInResume`
   * until `#onTurnEnd` resolves it, at which point it either sees `#turnId`
   * has moved on (a stop was decided — give up) or resumes speaking the very
   * same turn with a fresh `AbortController` (anything else).
   */
  #muteForBargeIn(): void {
    this.#pausedForBargeIn = true;
    this.#tts?.abort();
    this.#bargeInReady = this.#deps.audioOut.flush().then(({ heardMs }) => {
      // `#run`'s loop also calls `#confirmSpoken` once `#play()` itself
      // returns 'paused', but that and this `.then()` are two independent
      // async chains racing off the same synchronous `#tts.abort()` above —
      // neither is guaranteed to run before the other. `#heardPrefix` below
      // reads `#spoken` directly, so it must not depend on which one wins:
      // confirm here too, using the same pre-flush `#answerMsSoFar()` this
      // call is about to hand `#heardPrefix`. Idempotent and monotonic (see
      // `#confirmSpoken`'s own comment), so calling it twice for the same
      // pause costs nothing.
      this.#confirmSpoken(this.#answerMsSoFar());
      // Computed against the pre-flush `#enqueuedMs` — the whole answer as
      // enqueued so far — not the post-flush one: `#heardPrefix` needs
      // `answerMs` (how much of the answer was ever enqueued) to stay the
      // real total, or `heardMs` ends up compared against itself and every
      // barge-in reports the full answer as heard, however little actually
      // played (see the regression this exact ordering fixed).
      this.#bargeInHeard = this.#heardPrefix(heardMs);
      // The resume cursor, and the ONLY place it advances: computed against
      // what the device actually played, not what `#confirmSpoken` just
      // promoted off the enqueued count. `flush()` above permanently discarded
      // everything still queued — up to PLAYBACK_HIGH_WATER_MS of it — so a
      // resume keyed on `#spoken` would skip sentences nobody heard. Must run
      // before the `#enqueuedMs`/`#answerFromMs` rebase below, which moves the
      // very marks `#heardAnswerMs` reads.
      this.#confirmRendered(this.#heardAnswerMs(heardMs));
      // The other turn boundary, and the one Task 7 exists for: every number
      // §5's hypothesis is about, read at the exact moment they are compared
      // — before the reassignment below, so `enqueuedMs` here is the whole
      // answer as enqueued, matching what `#heardPrefix` just used.
      this.#debug(
        `barge-in: enqueuedMs=${this.#enqueuedMs} answerFromMs=${this.#answerFromMs} ` +
          `asideMs=${this.#asideMs} heardMs=${heardMs} prefix=${JSON.stringify(this.#bargeInHeard)}`,
      );
      // flush() discarded audio `#enqueuedMs` had already counted — it is a
      // lifetime counter and never rolls back on its own — so the two
      // timelines drift apart by the dropped amount at each mute until, on
      // the second, `heardMs - #answerFromMs` goes negative and the prefix
      // reports that nothing was heard. After a flush, what the device
      // rendered IS everything that ever reached the speakers, so adopt that
      // count.
      //
      // The marks that locate the answer inside that timeline have to come
      // with it. They are anchored once per TURN, not once per `#play()` call
      // (see `#play`'s own comment), so by the time a mute happens they are
      // already set and truncating `#enqueuedMs` underneath them is what
      // desyncs the pair. Concretely: a 1470ms progress line anchors
      // `#answerFromMs = 1470`, a barge-in 500ms in leaves `#enqueuedMs = 500`
      // against it, and `#answerMsSoFar()` is then NEGATIVE for the rest of
      // the turn — `#confirmSpoken` stops promoting (the note's corpus freezes
      // and silently loses every later sentence) and `#heardPrefix` returns ''
      // for an answer the user plainly heard. Aside spans need the same
      // treatment: one whose `end` is past `heardMs` covers audio that no
      // longer exists, and `#heardPrefix`'s `Math.min(end, heardMs)` would
      // keep crediting the discarded part as rendered.
      this.#answerFromMs = Math.min(this.#answerFromMs, heardMs);
      this.#asideSpans = this.#asideSpans
        .map(([start, end]): [number, number] => [Math.min(start, heardMs), Math.min(end, heardMs)])
        .filter(([start, end]) => end > start);
      this.#asideMs = this.#asideSpans.reduce((total, [start, end]) => total + (end - start), 0);
      this.#enqueuedMs = heardMs;
    }).catch((err) => {
      this.#debug(
        `bargeIn: flush/heardPrefix computation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * How much of this answer's audio has been enqueued so far, this turn —
   * the same expression `#heardPrefix` calls `answerMs`, factored out because
   * `#confirmSpoken`'s two call sites (`#run`'s loop and `#muteForBargeIn`)
   * both need exactly this number, computed the same way, at the moment they
   * ask for it (never cached: `#enqueuedMs` keeps moving under `#play()`).
   */
  #answerMsSoFar(): number {
    return this.#enqueuedMs - this.#answerFromMs - this.#asideMs;
  }

  /**
   * Promote as many of `#fed`'s leading, not-yet-`#spoken` sentences as
   * `renderedMs` — audio actually enqueued via `#emit`, post the
   * `#waitForRoom` throttle, never the feed side a real Voice's `feeding`
   * task races ahead on unbounded — can safely account for.
   *
   * There is no sentence-to-audio boundary to read (see `#heardPrefix`'s own
   * comment; `Voice` hands back one flat `AudioFrame` stream), so this is an
   * estimate: a sentence is promoted only once ALL of its
   * `CONSERVATIVE_MS_PER_CHAR`-estimated duration fits inside `renderedMs`,
   * added to the (same-estimated) duration of everything already promoted
   * ahead of it. A sentence still (even mostly) in flight is left for the
   * next call rather than guessed in — see that constant's own comment for
   * why under-estimating, not over-estimating, is the safe direction.
   *
   * Monotonic and idempotent: only ever appends to `#spoken`, so calling
   * this twice for the same pause (see `#muteForBargeIn`) or with a
   * `renderedMs` that has not grown since the last call does nothing extra.
   * `Number.POSITIVE_INFINITY` (see `#run`) promotes everything remaining in
   * `#fed` unconditionally — the exact, not estimated, case: a `#play()`
   * call that returned 'finished' drained every frame for everything it fed.
   */
  #confirmSpoken(renderedMs: number): void {
    let cursor = this.#spoken.length;
    let elapsedMs = 0;
    for (const sentence of this.#spoken) elapsedMs += sentence.length * CONSERVATIVE_MS_PER_CHAR;
    while (cursor < this.#fed.length) {
      const next = this.#fed[cursor]!;
      const projectedMs = elapsedMs + next.length * CONSERVATIVE_MS_PER_CHAR;
      if (projectedMs > renderedMs) break;
      this.#spoken.push(next);
      elapsedMs = projectedMs;
      cursor++;
    }
  }

  /**
   * Advance `#renderedCount` over as many of `#fed`'s leading sentences as
   * `renderedMs` — audio the device has actually PLAYED, i.e. `#heardAnswerMs`
   * of a `flush()`'s `heardMs`, never the enqueued count `#confirmSpoken`
   * takes — can account for.
   *
   * Same conservative whole-sentence estimate as `#confirmSpoken` (see that
   * comment, and `CONSERVATIVE_MS_PER_CHAR`'s), and erring in the same
   * direction for a sharper reason: under-counting here re-speaks a sentence
   * the user had already partly heard, which is merely redundant, while
   * over-counting skips one they never heard at all, leaving a silent hole in
   * the middle of the answer. Monotonic and idempotent, so the two chains
   * racing off a single `#tts.abort()` (see `#muteForBargeIn`) can both call it.
   */
  #confirmRendered(renderedMs: number): void {
    let elapsedMs = 0;
    for (let i = 0; i < this.#renderedCount; i++) {
      elapsedMs += this.#fed[i]!.length * CONSERVATIVE_MS_PER_CHAR;
    }
    while (this.#renderedCount < this.#fed.length) {
      const next = this.#fed[this.#renderedCount]!;
      const projectedMs = elapsedMs + next.length * CONSERVATIVE_MS_PER_CHAR;
      if (projectedMs > renderedMs) break;
      elapsedMs = projectedMs;
      this.#renderedCount++;
    }
  }

  /**
   * How much of THIS answer's audio the device has actually played, given a
   * `heardMs` from `flush()` — the device-lifetime rendered total located
   * inside this turn the same way `#heardPrefix` locates it, and factored out
   * of it so `#confirmRendered` measures against exactly the same quantity.
   */
  #heardAnswerMs(heardMs: number): number {
    // Only the aside audio actually rendered counts against us; see
    // `#heardPrefix`'s own comment for why the full enqueued `#asideMs` would
    // over-subtract.
    let renderedAside = 0;
    for (const [start, end] of this.#asideSpans) {
      renderedAside += Math.max(0, Math.min(end, heardMs) - start);
    }
    return Math.min(
      Math.max(0, heardMs - this.#answerFromMs - renderedAside),
      Math.max(0, this.#answerMsSoFar()),
    );
  }

  /**
   * Map playback milliseconds back onto the text that produced them.
   *
   * `heardMs` is cumulative for the life of the device, not for this turn, so
   * the turn's own audio has to be located inside that timeline first — hence
   * `#answerFromMs`. Comparing it against a per-turn total instead would make
   * every barge-in after the first look complete, and the note would then tell
   * Claude the user heard an answer they cut off after two words, which is the
   * exact failure §6 exists to prevent.
   *
   * Within the turn, `Voice` hands back one flat frame stream, so there is no
   * sentence-to-audio boundary to read and proportion by character count is the
   * honest approximation. It is clamped at both ends: audio that never left the
   * queue cannot have been heard, and audio enqueued before the answer began —
   * an approval question — is not part of the answer. Neither is
   * audio the Director spoke *during* the answer, which is what `#asideMs`
   * removes: `#answerFromMs` cannot see it, because it is already behind it.
   */
  #heardPrefix(heardMs: number): string {
    const text = this.#spoken.join(' ');
    const answerMs = this.#answerMsSoFar();
    if (!text || answerMs <= 0) return '';

    // See `#heardAnswerMs`: it carries the aside-overlap clamp this used to do
    // inline, so `#confirmRendered` cannot drift from what is reported here.
    const heardOfAnswer = this.#heardAnswerMs(heardMs);
    if (heardOfAnswer <= 0) return '';
    if (heardOfAnswer >= answerMs) return text;

    const chars = Math.floor(text.length * (heardOfAnswer / answerMs));
    const boundary = text.lastIndexOf(' ', chars);
    return text.slice(0, boundary > 0 ? boundary : chars).trim();
  }

  async #onTurnEnd(): Promise<void> {
    // Whether an onset was ever recorded for the utterance ending here, read
    // before the clear below wipes it. It is what tells a real utterance apart
    // from a turnEnd with nothing behind it, in a state that no longer says so.
    const wasCapturing = this.#capturing;
    const capturingFrom = this.#capturingFrom;
    // The utterance is over whatever it turns out to be, so capture stops here
    // — on every path out of this method, including the ones that route
    // nothing. Cleared up front rather than once a route has been chosen
    // because every route below has an await in it: leaving it set across that
    // await is what would feed whisper for the rest of the answer, and setting
    // it after would clobber a fresh onset that arrived inside the await.
    this.#capturing = false;
    this.#capturingFrom = null;

    // A follow-up: capture that began while the agent was working (THINKING)
    // or while it was still speaking the answer (SPEAKING, muted at onset by
    // `#muteForBargeIn` — see its own doc comment). Where the state has since
    // moved to does not change what the user meant: the two earlier fixes
    // already cover THINKING -> SPEAKING (the first sentence landed) and
    // THINKING -> LISTENING (the answer finished, handled below). This adds
    // THINKING -> AWAITING_APPROVAL, where a permission prompt arrived
    // mid-sentence and the state now reads as if the utterance were the
    // prompt's answer, AND the SPEAKING case, where the onset itself already
    // moved the state to HEARING before this ever runs — `#pausedForBargeIn`
    // is what says the turn is still alive there, since `this.#state` alone
    // no longer does. While the turn is still in flight it is a
    // stop-or-queue, decided by `isStopCommand`: only an explicit "basta" (or
    // equivalent) cancels it; anything else — including an echo that
    // recaptures to nothing, or an ordinary remark — is a follow-up, and the
    // turn's own work (a running tool call, a subagent Task, any further
    // sentences it still has to speak) is left completely untouched.
    // LISTENING is deliberately not this branch, since there is then nothing
    // to queue behind and nothing to stop.
    const beganWhileWorking = capturingFrom === 'THINKING' || capturingFrom === 'SPEAKING';
    const wasPausedForBargeIn = this.#pausedForBargeIn;
    const stillInFlight =
      this.#state === 'THINKING' ||
      this.#state === 'SPEAKING' ||
      this.#state === 'AWAITING_APPROVAL' ||
      wasPausedForBargeIn;
    if (beganWhileWorking && stillInFlight) {
      const id = this.#turnId;
      const said = await this.#takeFinal();
      // Forcing the final transcription is a round trip; a stop command
      // decided elsewhere, an audio failure or stop() can all land inside it.
      if (this.#turnId !== id) return;
      // #muteForBargeIn's flush is a single, fast round trip; the recapture
      // above is a whole utterance plus its own round trip, so in practice
      // this never actually waits. Awaited anyway so `#bargeInHeard` below is
      // never read before it exists.
      if (wasPausedForBargeIn) await this.#bargeInReady;
      if (this.#turnId !== id) return;

      if (isStopCommand(said)) {
        this.#turnId++;
        this.#tts?.abort();
        // "basta" said into a running search has to silence the search's own
        // narration too, or the cancelled turn keeps talking for three seconds.
        this.#stopProgress();
        this.#stopTurnTimer();
        // A permission request can have arrived inside the await above without
        // bumping #turnId. Leaving it unresolved strands the SDK's canUseTool
        // promise with its timer armed, and approvalTimeoutMs later it speaks
        // GAVE_UP into a moment that has nothing to do with it.
        this.#resolveApproval(false);
        void this.#deps.agent.interrupt();
        this.#setState('LISTENING');
        // A stop word cancels the line of thought it interrupted. Anything
        // still waiting from earlier in that same line must not resurrect once
        // the next, unrelated turn is done answering.
        this.#queued = [];
        if (wasPausedForBargeIn) {
          // The stop word itself is never dispatched as a question (it is a
          // cancellation, not a request), so there is no `#ask()` call here to
          // consume what was heard before it. Stash it for whatever the user
          // says next instead — the same `#pendingNote` mechanism an ordinary
          // barge-in has always used.
          this.#pendingNote = this.#bargeInHeard;
          this.#releaseBargeIn();
        }
        return;
      }
      if (said) {
        // Checked here too, not only on the ordinary LISTENING path further
        // below: an utterance that starts while the Director is THINKING (or
        // paused mid-SPEAKING on a barge-in) never reaches that path at all —
        // it is routed here, queued, and later drained straight into #ask()
        // (see `#queued`'s own comment, and #run's "Drained at the end of
        // #run" drain). Without this check a spoken GUI command ("attiva la
        // gui") said while a tool is running would reach Claude instead of
        // being handled locally, in exactly the background-work case the
        // check exists to bypass (gui-command.ts).
        const gui = interpretGuiCommand(said);
        if (gui) {
          void this.#deps.runGui(gui).then((line) => this.#say(line));
        } else {
          this.#queued.push(said); // Drained at the end of #run.
        }
      }
      if (wasPausedForBargeIn) {
        // Not a stop command — nothing was actually cancelled, so there is
        // nothing to tell Claude it missed. Resume the very same turn:
        // `#run`'s loop is blocked on exactly this resolving.
        //
        // Restore SPEAKING before releasing: the onset already moved
        // `#state` to HEARING (see `#onSpeechStart`), and nothing else was
        // ever going to move it back — `#run`'s loop resumes `#play()`
        // directly, without passing back through the THINKING->SPEAKING
        // transition (`sentences`'s own generator, further down, only fires
        // that transition once, from THINKING). Left at HEARING, a SECOND
        // onset during this same resumed answer would hit
        // `#onSpeechStart`'s early return for HEARING, never call
        // `#muteForBargeIn` again, and — because `capturingFrom` would then
        // read 'HEARING', not 'SPEAKING' — fall through `#onTurnEnd` into
        // `#ask()`, starting a second, concurrent `#run` over the still-live
        // first one. Found in code review (2026-09-27) against this exact
        // redesign.
        //
        // BUT: `#onPermission` can have fired independently of this pause
        // (it is driven by the SDK's own `canUseTool` callback, not gated on
        // `#pausedForBargeIn`) while the recapture's transcript was still in
        // flight, moving `#state` to AWAITING_APPROVAL with its own live
        // `#approval` resolve/timer pair already armed. Restoring SPEAKING
        // here would clobber that — the user's real answer to the approval
        // question would then be misread as a second barge-in onset instead
        // of routing to `#answer()`, and get silently discarded when
        // `#onPermission`'s own timeout eventually fires. Leave the state and
        // the pause exactly as `#onPermission` left them; the approval
        // machinery (not this resume path) owns resolving it. Found in code
        // review (2026-09-27).
        if (this.#state !== 'AWAITING_APPROVAL') {
          this.#setState('SPEAKING');
          this.#releaseBargeIn();
        }
      }
      return;
    }

    // LISTENING with an onset behind it is the same follow-up as the branch
    // above, one beat later: the user began talking while the agent worked and
    // was still talking when the answer ended, so #run had already returned the
    // state to LISTENING by the time this fired. The utterance is real either
    // way — dropping it here is the silence that feels exactly like being
    // ignored, which is the defect this whole model exists to remove. It is not
    // routed through the in-flight branch, though: with the answer finished
    // there is nothing to queue behind and, deliberately, nothing to stop
    // either. isStopCommand is not consulted on this path — "basta" said into
    // an idle agent is an ordinary utterance, not a cancellation of a turn that
    // has already ended.
    const finishedUnderTheUser = this.#state === 'LISTENING' && wasCapturing;
    if (
      !finishedUnderTheUser &&
      this.#state !== 'HEARING' &&
      this.#state !== 'AWAITING_APPROVAL'
    ) {
      return;
    }

    const id = this.#turnId;
    const text = await this.#takeFinal();
    // Forcing the final transcription is a round trip, and an approval timeout,
    // an audio failure or stop() can all land inside it. Acting on the result
    // afterwards would answer a question that no longer exists, or start a turn
    // out of a state that has already moved on.
    if (this.#turnId !== id) return;

    if (this.#state === 'AWAITING_APPROVAL') {
      void this.#answer(text);
      return;
    }
    if (!text) {
      // A cough that whisper turned into "[Musica]" is not a turn. Note that
      // a SPEAKING-onset recapture never reaches this branch any more: it is
      // routed through `beganWhileWorking` above, whether it turns out to be
      // a stop, a follow-up, or — same as here — nothing at all, in which
      // case the paused turn is simply resumed with no apology, since nothing
      // was actually cancelled (see that branch's own comment).
      this.#setState('LISTENING');
      return;
    }
    const gui = interpretGuiCommand(text);
    if (gui) {
      // Never reaches Claude: see gui-command.ts for why. Handled as a spoken
      // line the Director says itself, not a turn the agent answers. Same
      // stale-note hazard as the `!text` branch above: this path never calls
      // `#ask()` either.
      this.#pendingNote = undefined;
      this.#setState('LISTENING');
      void this.#deps.runGui(gui).then((line) => this.#say(line));
      return;
    }
    this.#ask(text);
  }

  /**
   * `setMuted(true)`'s own equivalent of `#takeFinal`: closes whatever
   * capture stream is currently open — flushing (and discarding) any
   * buffered samples — and opens a fresh one in its place, so the next
   * utterance after unmuting starts from an empty buffer instead of being
   * appended onto stale pre-mute audio (see `setMuted`'s own comment for the
   * full mechanism). Unlike `#takeFinal`, the resulting transcript is never
   * read: it belongs to speech the user explicitly cut off by muting.
   */
  async #discardStream(): Promise<void> {
    const stream = this.#stream;
    this.#stream = undefined;
    await stream?.close(this.#language);
    await this.#openStream();
  }

  /** Close the stream to force the final transcription, then open the next one. */
  async #takeFinal(): Promise<string> {
    const stream = this.#stream;
    this.#stream = undefined;
    // Lets a short final request its language explicitly instead of 'auto'
    // (see transcriber.ts's MIN_AUDIO_MS_FOR_LANGUAGE_DETECT) — plumbed here,
    // not defaulted inside the stream, because only the Director knows the
    // conversation's current sticky language.
    await stream?.close(this.#language);
    const text = clean(this.#lastFinal);
    await this.#openStream();
    return text;
  }

  // ------------------------------------------------------------------ talking

  #ask(text: string): void {
    const note = this.#pendingNote;
    this.#pendingNote = undefined;
    if (note !== undefined) this.#deps.agent.notifyInterruption(note, text);

    // The turn boundary Task 7 starts reading from: without the transcript
    // here, a barge-in's numbers further down have nothing to be numbers about.
    this.#debug(`turn: transcript=${JSON.stringify(text)}`);
    this.#setState('THINKING');
    void this.#run(text);
  }

  async #run(text: string): Promise<void> {
    const id = ++this.#turnId;
    this.#spoken = [];
    this.#fed = [];
    this.#renderedCount = 0;
    // Provisional: #play moves it to where the answer's first frame actually
    // lands, so an approval question played in between is not counted as answer.
    this.#answerFromMs = this.#enqueuedMs;
    this.#asideMs = 0;
    this.#asideSpans = [];
    // Whether #play has emitted its first frame yet FOR THIS WHOLE TURN, not
    // for a single #play() call: a SPEAKING-onset mute can pause and resume
    // the same turn several times over (see the loop below), and re-anchoring
    // #answerFromMs/#asideMs on every resume would make #heardPrefix measure
    // a later segment's audio against ALL of #spoken's text, over-crediting
    // a stop that lands after a second pause with sentences it never played.
    this.#answerStarted = false;
    this.#toolsRunning = 0;
    // A brand-new turn cannot legitimately inherit an approval pause from
    // whatever came before it — by the time `#ask()`/`#run()` runs, any
    // approval belonging to a previous turn has already been resolved one
    // way or another. Left uncleared, a leaked value here (every exit from
    // `AWAITING_APPROVAL` except a plain yes/no answer used to skip clearing
    // it — the stop-command branch in `#onTurnEnd`, `#onPermission`'s own
    // timeout, `#abandon()`, `stop()`, and the 'unclear' redispatch branch
    // below) survives into THIS turn's own, later approval: `#onPermission`
    // only sets `#approvalPauseStart` on a genuinely undefined value (so
    // concurrent approvals don't clobber each other), sees the stale one and
    // leaves it alone, and `#answer()` then credits back the elapsed time
    // since the OLD, unrelated pause — silently inflating `#turnDeadline` by
    // however long ago that was, defeating the hard ceiling it exists to
    // enforce (see the regression test for exactly this).
    this.#approvalPauseStart = undefined;
    this.#turnDeadline = this.#timers.now() + this.#deps.config.director.turnTimeoutMs;
    this.#armTurnTimer(id);
    this.#debug('director: turn timer armed, awaiting agent.send()');

    const director = this;
    // The filter eats the whole event stream and yields only sentences, so the
    // tool brackets — the only warning anyone gets that the next minute is
    // going to be silent — are invisible downstream. Observe them on the way
    // past and forward them unchanged: the filter needs a tool event to close
    // the text block it interrupts.
    const observed = (async function* () {
      for await (const event of director.#deps.agent.send(text)) {
        if (director.#turnId !== id) return;
        if (event.type === 'tool') {
          director.#debug(`tool: ${event.phase} ${event.name}`);
          if (event.phase === 'start') {
            // Only the first of a group of parallel calls arms the timer; a
            // second, third, ... call arriving while one is already running
            // must not restart the cadence or reset which line comes next.
            if (director.#toolsRunning++ === 0) director.#startProgress(event.name);
          } else {
            // Floored at 0: an `end` for a tool whose `start` belonged to a
            // turn that already ended cannot happen (the turnId guard above
            // returns first), but nothing here should go negative if it ever did.
            director.#toolsRunning = Math.max(0, director.#toolsRunning - 1);
            if (director.#toolsRunning === 0) director.#stopProgress();
          }
        }
        yield event;
      }
    })();

    const sentences = (async function* () {
      for await (const sentence of director.#deps.filter.filter(observed)) {
        if (director.#turnId !== id) return;
        // Tool narration ends when the real answer starts speaking (spec §4).
        director.#stopProgress();
        // NOT `#spoken.push(sentence)` (nor `#fed.push(sentence)`) here —
        // this generator is what `relay()`'s pump drives, at the agent's own
        // pace, independent of whether anything is currently paused for a
        // barge-in (see relay()'s doc comment: the pump never stops for a
        // pause). Pushing to either array here would keep growing it for the
        // whole time a barge-in pause sits waiting on `#onTurnEnd`, crediting
        // the user with sentences that were generated but never reached a
        // live `voice.synthesize()` call, let alone the speakers. See
        // `#trackFed`, downstream of `relay()`'s per-view cursor, for where
        // the fed side is actually tracked, and `#confirmSpoken` for how a
        // sentence graduates from fed to spoken.
        if (director.#state === 'THINKING') director.#setState('SPEAKING');
        yield sentence;
      }
    })();
    // A SPEAKING-onset pause can send `sentences` through more than one
    // `#play()` call (see the loop below). Only `relay()`'s own pump is ever
    // allowed to pull from `sentences` directly — see its doc comment for why
    // handing the raw generator to a second `voice.synthesize()` call would
    // silently drop or hang on the sentence produced right after a resume.
    const nextSentenceStream = relay(sentences);

    // Read once, at the point the answer is about to be spoken, not at the
    // top of #run: #maybeSwitchLanguage only ever fires from a *final*
    // transcript (director.ts's #openStream), and the one that triggered
    // this very turn already landed via #takeFinal() before #ask()/#run()
    // were called — so by the time we get here #language already reflects
    // whatever this turn's own utterance decided, with no extra plumbing
    // needed through #ask()/#run()'s text parameter.
    const language = this.#language;
    // One turn can pass through #play() more than once: a SPEAKING-onset mute
    // (`#muteForBargeIn`) stops the current #play() call without ending the
    // turn, and once `#onTurnEnd` decides the recapture was not a stop
    // command, this loop resumes speaking — via a fresh view onto the same
    // relay, never the raw `sentences` generator directly (see `relay()`'s
    // doc comment) — with a fresh AbortController. A stop command, or the
    // turn's own sentences simply running out, are the only ways out of the
    // loop.
    for (;;) {
      const tts = new AbortController();
      this.#tts = tts;
      // Discard any unrendered tail a previous (aborted) attempt at this
      // same resume point left behind: the view constructed below re-feeds
      // those exact sentences again, from `relay()`'s buffer, starting at
      // `#renderedCount` — so `#fed` carrying stale duplicates from the
      // abandoned attempt would double-count them and desync `#fed`'s order
      // from relay's. See `#fed`'s own doc comment.
      this.#fed.length = this.#renderedCount;
      let outcome: 'finished' | 'paused' | 'cancelled';
      try {
        // `#renderedCount` counts the sentences the DEVICE has played, in the
        // same order `relay()`'s buffer holds them — so it doubles as the
        // resume cursor: the first call in this loop starts at 0 (nothing
        // played yet), and a resume after a pause starts exactly where the
        // speakers got to, never where `#confirmSpoken` promoted to (that is
        // the enqueued count, and the barge-in's `flush()` discarded the
        // difference) nor where the Voice's own eager, unbounded feed happened
        // to read to. See relay()'s doc comment (b), `#trackFed`'s,
        // `#renderedCount`'s and `#confirmRendered`'s.
        const view = this.#trackFed(nextSentenceStream(this.#renderedCount), tts.signal);
        outcome = await this.#play(view, tts.signal, id, language);
      } catch (error) {
        if (this.#turnId === id) this.#abandon(`turn failed: ${String(error)}`, TURN_FAILED);
        return;
      }
      if (outcome === 'cancelled') return; // #turnId already moved on elsewhere.
      if (outcome === 'finished') {
        // Exact, not estimated: 'finished' means the iterator this call fed
        // reached `done`, so every frame for everything in `#fed` was
        // emitted — see `#play`'s own loop.
        this.#confirmSpoken(Number.POSITIVE_INFINITY);
        this.#renderedCount = this.#fed.length;
        break;
      }
      // 'paused': confirm whatever the render side can safely account for
      // before this loop reads `#spoken.length` again above, so a resume
      // never starts past audio that was fed to the Voice but never actually
      // rendered (see `#confirmSpoken`'s own comment for the estimate this
      // makes, and why it errs conservative).
      this.#confirmSpoken(this.#answerMsSoFar());

      // 'paused': muted by a speech onset, not yet decided. #onTurnEnd (or
      // `setMuted(true)`, which can release the same pause without ever
      // going through `#onTurnEnd` — see its own comment) resolves this.
      //
      // Guarded first: if something already cleared `#pausedForBargeIn`
      // between `#play()` returning 'paused' and this line — not a normal
      // path, but cheap to guard against and expensive to get wrong —
      // parking on a promise nothing is left to resolve would silently wedge
      // this turn for the rest of `turnTimeoutMs`. A release that lands
      // exactly here instead still reaches the loop: `#releaseBargeIn`
      // resolves `#bargeInResume` itself whenever it runs, so the only way
      // to actually miss it is if it ran and cleared the flag BEFORE
      // `#bargeInResume` below was ever assigned — which is exactly this
      // check.
      if (!this.#pausedForBargeIn) continue;
      await new Promise<void>((resolve) => {
        this.#bargeInResume = resolve;
      });
      if (this.#turnId !== id) return; // Decided: an explicit stop cancelled it.
      // Otherwise: not a stop command, the turn is untouched — loop around
      // and resume speaking it.
    }

    if (this.#turnId !== id) return;
    // A stream that ends inside a tool bracket — an interrupt, a crashed tool —
    // leaves the timer armed with nothing left to narrate.
    this.#stopProgress();
    this.#stopTurnTimer();
    this.#setState('LISTENING');

    // Said while the answer was in flight. It was deliberately not allowed to
    // interrupt, so it must not be silently dropped either.
    const next = this.#queued.shift();
    if (next !== undefined) this.#ask(next);
  }

  /**
   * Wraps a `relay()` view so `#fed` grows for every sentence handed to a
   * LIVE `voice.synthesize()` call, in the same order `relay()` buffers
   * them — never for ones the pump merely produced while nothing was
   * consuming (a barge-in pause). This is the EAGER, fed side only: a real
   * Voice's own `feeding` task (cartesia.ts:277-286) is an unbounded drain —
   * `for await (const sentence of text) { send(sentence, true) }` — that
   * pulls from this generator as fast as it can, independent of how much of
   * anything it has already pulled has actually reached the speakers. That
   * is exactly why this does NOT push to `#spoken` (the previous shape of
   * this method did, and that was the bug: see `#fed`'s and
   * `#confirmSpoken`'s own doc comments, and the class-level barge-in note).
   * `#confirmSpoken` is the only thing that promotes an entry from here into
   * `#spoken`, using the render side (`#emit`/`#waitForRoom`), never this one.
   *
   * `signal` is this specific `#play()` call's own abort signal, not a stand-
   * in for `relay()`'s generation counter — the two lag each other. An abort
   * fires the instant a barge-in mutes or a stop cancels, but the OLD view
   * this generator is wrapping stays "current" (its generation number keeps
   * matching) until `#run`'s loop actually gets back around to calling
   * `nextSentenceStream()` for the next `#play()`. In that window the pump
   * can still wake this (already-abandoned) view with a freshly produced
   * sentence; without the check below it would be counted into `#fed` even
   * though the `voice.synthesize()` call it's headed for has already
   * discarded it — inflating `#fed` with a sentence this specific view never
   * actually handed anywhere live.
   */
  async *#trackFed(view: AsyncGenerator<string>, signal: AbortSignal): AsyncGenerator<string> {
    for await (const sentence of view) {
      if (signal.aborted) return;
      this.#fed.push(sentence);
      yield sentence;
    }
  }

  async #play(
    sentences: AsyncIterable<string>,
    signal: AbortSignal,
    id: number,
    language: string,
  ): Promise<'finished' | 'paused' | 'cancelled'> {
    const sinks = this.#deps.sinks ?? [];
    let emittedThisSegment = false;

    // Driven by hand, not `for await`, and every pull raced against the abort
    // signal directly: a `for await` trusts `voice.synthesize()` to notice
    // its own signal and return promptly, but that is a property of whatever
    // Voice happens to be plugged in, not a guarantee `#play()` itself makes.
    // The real Cartesia client happens to do this (its own generator loop
    // watches a `done`/`notify` pair set by an abort listener, independent of
    // whatever its internal feed of `sentences` is doing) — but relying on
    // that would make "a mute pauses instantly" an incidental property of one
    // provider, exactly what the swappability rule exists to rule out. Racing
    // here means an abort unblocks this loop even against a Voice — real or
    // fake — whose generator is simply suspended awaiting its next sentence.
    const iterator = this.#deps.voice.synthesize(sentences, signal, language)[Symbol.asyncIterator]();

    /**
     * One `iterator.next()` call, raced against the abort signal, cleaning
     * its own listener up as soon as EITHER side settles. Not
     * `Promise.race([iterator.next(), aborted])` against one long-lived
     * `aborted` promise reused every pull: `Promise.race` attaches a fresh
     * `.then` reaction to each promise it is given, so reusing the same
     * `aborted` promise across every frame of a long answer — dozens of
     * pulls per second — piles up thousands of reactions on it, all held
     * alive until the turn's own abort fires (if it ever does). Here, the
     * common case (`iterator.next()` wins) removes the abort listener
     * immediately instead of leaving it registered for the rest of the turn.
     */
    const pullOrAbort = (): Promise<IteratorResult<AudioFrame> | 'aborted'> => {
      if (signal.aborted) return Promise.resolve('aborted');
      return new Promise((resolve, reject) => {
        const onAbort = (): void => resolve('aborted');
        signal.addEventListener('abort', onAbort, { once: true });
        iterator.next().then(
          (result) => {
            signal.removeEventListener('abort', onAbort);
            resolve(result);
          },
          (err: unknown) => {
            signal.removeEventListener('abort', onAbort);
            reject(err);
          },
        );
      });
    };

    try {
      for (;;) {
        if (signal.aborted || this.#turnId !== id) break;
        const pulled = await pullOrAbort();
        if (pulled === 'aborted' || signal.aborted || this.#turnId !== id) break;
        if (pulled.done) break;
        const frame = pulled.value;

        if (!this.#answerStarted) {
          this.#answerStarted = true;
          this.#answerFromMs = this.#enqueuedMs;
          // Everything the Director said up to here is already behind the mark.
          this.#asideMs = 0;
          this.#asideSpans = [];
        }
        if (!emittedThisSegment) {
          emittedThisSegment = true;
          for (const sink of sinks) sink.onSpeechStart();
        }
        await this.#waitForRoom(signal, id);
        if (signal.aborted || this.#turnId !== id) break;
        this.#emit(frame, sinks, 'answer');
      }
    } finally {
      // Every exit above is a bare `break` inside a hand-rolled loop, not a
      // `for await` — so nothing here gets the iterator-closing guarantee a
      // `for await` gives for free. Without this, a Voice's own cleanup
      // (cartesia.ts's listener removal / clearTimeout / socket.close(), all
      // sitting in its generator's own `finally`) only ever ran on a turn
      // that reached natural completion, never on one paused or cancelled —
      // silently, since nothing here surfaced the difference.
      //
      // NOT awaited: per the async-generator spec, a `.return()` queued
      // behind an outstanding `.next()` does not settle until that `.next()`
      // does — and `pullOrAbort` above deliberately abandons its own
      // `.next()` call the instant the abort signal wins the race (that is
      // the whole point of racing it at all, see this loop's own top
      // comment). Awaiting `.return()` here would then block THIS call's own
      // return on however long the Voice's generator takes to notice the
      // same abort signal itself — a property of whichever Voice happens to
      // be plugged in, exactly what racing `pullOrAbort` above exists to
      // rule out. Real Cartesia happens to resolve its pending pull promptly
      // on abort (cartesia.ts's `onAbort`/`finish`), but a conforming Voice
      // is not required to, and `#play()` returning promptly must not depend
      // on one that doesn't. Fire-and-forget; the rejection is swallowed so
      // a cleanup failure can never surface as an unhandled rejection — it
      // is not this call's failure to report, and the outcome below is
      // already decided by the loop above regardless of how cleanup goes.
      iterator.return?.()?.catch(() => {
        /* see comment above */
      });
    }

    if (emittedThisSegment) for (const sink of sinks) sink.onSpeechEnd();

    // Checked in this order on purpose: a genuine cancellation (#turnId moved
    // on — a stop command, stop(), an abandon) always wins over this specific
    // call's own abort signal, which a mute sets without ever touching
    // #turnId (see `#muteForBargeIn`).
    if (this.#turnId !== id) return 'cancelled';
    if (signal.aborted) return 'paused';
    return 'finished';
  }

  /**
   * Hold the answer back while the speakers catch up. The queue is finite and
   * the voice is much faster than speech, so without this a long answer is
   * accepted, dropped by the device, and never heard — the one failure mode
   * that produces no error anywhere unless the device reports the overflow.
   */
  async #waitForRoom(signal: AbortSignal, id: number): Promise<void> {
    while (
      this.#deps.audioOut.bufferedMs() > PLAYBACK_HIGH_WATER_MS &&
      !signal.aborted &&
      this.#turnId === id
    ) {
      await new Promise((resolve) => setTimeout(resolve, PLAYBACK_POLL_MS));
    }
  }

  /**
   * The one place audio reaches the speakers, so the one place it is counted —
   * and the one place that can tell the answer apart from the Director's own
   * voice, which is why the caller has to say which it is.
   */
  #emit(frame: AudioFrame, sinks: OutputSink[], kind: 'answer' | 'aside'): void {
    const ms = (frame.length / this.#deps.config.audio.deviceRate) * 1000;
    this.#enqueuedMs += ms;
    if (kind === 'aside') {
      const start = this.#enqueuedMs - ms;
      this.#asideMs += ms;
      const last = this.#asideSpans.at(-1);
      if (last !== undefined && last[1] === start) last[1] = this.#enqueuedMs;
      else this.#asideSpans.push([start, this.#enqueuedMs]);
    }
    this.#deps.audioOut.enqueue(frame);
    for (const sink of sinks) sink.onAudio(frame);
  }

  /** Speak one line the Director wrote itself: a progress line, a question, an apology. */
  async #say(line: string): Promise<void> {
    const sinks = this.#deps.sinks ?? [];
    // One at a time. Two of these overlapping — a progress line running into an
    // approval question, or two questions back to back — is not a degraded
    // answer, it is an unintelligible one.
    this.#line?.abort();
    const controller = new AbortController();
    this.#line = controller;

    try {
      const source = await only(toSpokenForm(line));
      // #language is sticky (see #maybeSwitchLanguage): once a real utterance
      // switches it mid-conversation, every subsequent synthesize() call must
      // follow, including the Director's own spoken lines here — not just the
      // agent's answers (#play() reads the same field the same way, just
      // below). Without this a confirmation or apology spoken after an
      // English switch would still come out in Italian.
      for await (const frame of this.#deps.voice.synthesize(source, controller.signal, this.#language)) {
        if (controller.signal.aborted) break;
        this.#emit(frame, sinks, 'aside');
      }
    } catch (error) {
      // A line that fails is not worth killing the turn for, but it is worth
      // saying out loud in the log — a voice that silently stops speaking is
      // indistinguishable from one that has nothing to say.
      this.#deps.onError?.(`voice: ${String(error)}`);
    } finally {
      if (this.#line === controller) this.#line = undefined;
    }
  }

  /** Silence the line the Director itself is speaking, if one is out loud. */
  #stopLine(): void {
    this.#line?.abort();
    this.#line = undefined;
  }

  /**
   * Narrate a tool call for as long as it runs.
   *
   * A web search is minutes of silence — the silence that started this project.
   * The line repeats, because the wait it is covering has no known length.
   */
  #startProgress(tool: string): void {
    this.#stopProgress();
    // The turn this tool belongs to. `Timers` has no setInterval, so the timer
    // re-arms itself, and a re-armed timer outlives whatever cleared the turn
    // unless it checks.
    const id = this.#turnId;
    let index = 0;

    const arm = (): void => {
      this.#progressTimer = this.#timers.setTimeout(() => {
        this.#progressTimer = undefined;
        if (this.#turnId !== id) return;
        // Narrating over the question the user is being asked would make the
        // question unanswerable. The tool has not started running yet anyway —
        // it is waiting for the very answer we would be talking over. Silence
        // now, re-armed: approval granted, the narration resumes on its own.
        if (this.#state !== 'AWAITING_APPROVAL') {
          void this.#say(progressLine(tool, index++));
        }
        arm();
      }, PROGRESS_EVERY_MS);
    };
    arm();
  }

  /**
   * A progress line already out loud has to be cut, not merely un-scheduled, or
   * it talks over the answer that has just arrived to replace it.
   */
  #stopProgress(): void {
    if (this.#progressTimer !== undefined) {
      this.#timers.clearTimeout(this.#progressTimer);
      this.#progressTimer = undefined;
    }
    this.#stopLine();
  }

  /**
   * The hard backstop for a turn whose stream never produces another event —
   * a genuinely hung network call inside the agent's tool, not merely a slow
   * one. Progress narration already covers the slow case; this covers "never".
   */
  #armTurnTimer(id: number): void {
    // Remaining time until the turn's absolute deadline, not a fresh
    // turnTimeoutMs window — see #turnDeadline's own comment for why.
    const remaining = Math.max(0, (this.#turnDeadline ?? this.#timers.now()) - this.#timers.now());
    this.#turnTimer = this.#timers.setTimeout(() => {
      this.#turnTimer = undefined;
      if (this.#turnId !== id) return;
      this.#abandon(
        `turn timed out after ${this.#deps.config.director.turnTimeoutMs}ms with no answer`,
        TURN_FAILED,
      );
    }, remaining);
  }

  #stopTurnTimer(): void {
    if (this.#turnTimer !== undefined) {
      this.#timers.clearTimeout(this.#turnTimer);
      this.#turnTimer = undefined;
    }
  }

  // ----------------------------------------------------------------- approval

  #onPermission(req: PermissionRequest): Promise<boolean> {
    // A second request while one is outstanding can only come from the turn we
    // were already thinking about.
    const from = this.#state === 'AWAITING_APPROVAL' ? 'THINKING' : this.#state;
    this.#resolveApproval(false);
    // The turn's own 45s clock must not keep running while nobody but the
    // user can move it forward — otherwise the approval wait (up to
    // approvalTimeoutMs) is spent out of the same budget the tool needs to
    // actually run once answered, silently shrinking it. Stopped here,
    // re-armed in #answer() once the turn actually resumes. The one path
    // that does NOT resume the turn — this method's own timeout below, which
    // fully abandons it — needs no re-arm, since nothing is left running to
    // time. Pausing only stops the JS timer, not the wall-clock deadline
    // itself, so the elapsed pause is added back onto #turnDeadline in
    // #answer() when it resumes — otherwise the wait would still silently
    // count against the budget, just without a reset-to-full-45s bug.
    this.#stopTurnTimer();
    // Only set on the FIRST outstanding pause, never overwritten by a second,
    // concurrent permission request landing before the first is answered
    // (the SDK can fire tools in parallel — see `#toolsRunning`'s own
    // comment). Overwriting here would silently charge the first pause's
    // elapsed wait (up to approvalTimeoutMs) against the turn's deadline
    // budget once #answer() only credits back the second pause's span —
    // exactly the accounting bug this mechanism exists to prevent.
    if (this.#approvalPauseStart === undefined) {
      this.#approvalPauseStart = this.#timers.now();
    }

    return new Promise<boolean>((resolve) => {
      const timer = this.#timers.setTimeout(() => {
        this.#resolveApproval(false);
        // The user walked away. Abandoning the turn is kinder than leaving a
        // half-finished answer to arrive at an empty room.
        this.#turnId++;
        this.#tts?.abort();
        this.#releaseBargeIn();
        // This #run will never reach the drain at the end of it — it's being
        // abandoned right here — so anything it had queued would otherwise sit
        // forgotten until surfacing, unasked-for, after a later turn.
        this.#queued = [];
        // The agent is still working on the turn nobody is waiting for, and its
        // result would otherwise surface in the middle of the next one.
        void this.#deps.agent.interrupt();
        this.#setState('LISTENING');
        void this.#say(GAVE_UP);
      }, this.#deps.config.director.approvalTimeoutMs);

      const entry = { resolve, from, timer };
      this.#approval = entry;
      this.#setState('AWAITING_APPROVAL');
      // `#say` is a separate audio channel from `#tts`/playback and is not
      // muted by `#muteForBargeIn` — unlike the answer itself, nothing stops
      // this question from being spoken straight over a barge-in pause that
      // is still open (the recapture's final transcript not back yet, the
      // stop-vs-follow-up decision not yet made by `#onTurnEnd`). Wait for
      // the pause's own flush to complete first: cheap (a single round trip,
      // per `#muteForBargeIn`'s own comment) and it is the one existing
      // signal that the immediate onset handling has settled. Still checked
      // against `this.#approval` afterwards — a stop command decided in the
      // meantime denies this exact approval via `#resolveApproval(false)`,
      // and a superseded question must not be spoken into a turn that has
      // already moved on.
      if (this.#pausedForBargeIn) {
        void this.#bargeInReady?.then(() => {
          if (this.#approval === entry) void this.#say(`Posso ${req.summary}?`);
        });
      } else {
        void this.#say(`Posso ${req.summary}?`);
      }
    });
  }

  async #answer(text: string): Promise<void> {
    const approval = this.#approval;
    if (!approval) return;

    const verdict = interpretApproval(text);

    // 'unclear' is a denial AND a new turn. Denying without re-dispatching
    // loses what the user said, which feels exactly like being ignored (§8).
    if (verdict === 'unclear' && text) {
      this.#resolveApproval(false);
      // Same leak the yes/no branch below already guards against (see its own
      // comment): a SPEAKING-onset barge-in pause can still be open here — the
      // permission request arrived mid-pause, exactly as `approval.from` being
      // 'HEARING' would show. Unlike that branch, this one does not resume the
      // paused turn; it replaces it outright with whatever the user just said,
      // via `#redispatch`. Left alone, `#run`'s loop for the paused turn stays
      // parked on `#bargeInResume` forever — nothing else was ever going to
      // resolve it — and `#pausedForBargeIn` stays wrongly true for the rest
      // of the session, corrupting later, unrelated turns' own pause/resume
      // bookkeeping (`#onTurnEnd`'s `stillInFlight`, `#onPermission`'s
      // barge-in defer). Bump `#turnId` FIRST, before releasing: the parked
      // `#run` wakes on `#releaseBargeIn` below, sees `#turnId` has already
      // moved on, and exits cleanly (see `#run`'s own loop) instead of racing
      // `#redispatch`'s own `#interrupt()` and resuming playback of a turn
      // that is being torn down underneath it. What the paused answer's
      // interruption missed is preserved as `#pendingNote`, the same
      // mechanism the stop-command branch in `#onTurnEnd` uses for the same
      // situation — the redispatched text below is exactly "whatever the user
      // says next" that note exists for.
      if (this.#pausedForBargeIn) {
        this.#turnId++;
        this.#pendingNote = this.#bargeInHeard;
        this.#releaseBargeIn();
      }
      this.#setState('HEARING');
      void this.#redispatch(text);
      return;
    }

    if (verdict === 'unclear') {
      // `interpretApproval('')` is also 'unclear' (empty is not consent), but
      // there is nothing to redispatch — an empty transcript, not a sentence
      // whisper failed to route. Denying it exactly as above but with zero
      // spoken feedback is silent from the user's side: they said something,
      // whisper lost it, and the tool call vanishes with no explanation at
      // all. A denial is still the right, fail-closed default; it just has
      // to be an audible one, same as GAVE_UP is for the timeout path.
      //
      // Awaited, not fired-and-forgotten: #resolveApproval below unblocks the
      // SDK's canUseTool promise immediately, and the turn can resume
      // speaking its own next answer while this line is still mid-synthesis
      // — two voices into the same audio output at once. Every other
      // Director-spoken line here is already guarded against exactly that
      // (GAVE_UP bumps #turnId before the turn could resume at all;
      // #abandon's #stopProgress() calls #stopLine()); this is the same
      // protection for the one path that had been missing it. #say() is
      // bounded by its own AbortController-driven cleanup (voice.synthesize's
      // connect handshake has its own timeout), so this cannot hang forever.
      const id = this.#turnId;
      await this.#say(DIDNT_CATCH);
      // A barge-in, a stop word, or an abandon can all land inside that
      // await. If the turn moved on, resolving this approval and touching
      // state or the turn timer would act on a turn that no longer exists.
      if (this.#turnId !== id) return;
      // The turnId guard above does NOT catch every case: #onPermission can
      // land a second, unrelated approval request during this same await
      // without bumping #turnId (its own doc comment says as much). `approval`
      // is the one captured at entry to this method — if `this.#approval` is
      // no longer that same object, a newer approval has since taken its
      // place, and resolving/denying it here (or touching state/the turn
      // timer for it) would silently destroy the wrong, newer approval that
      // is still legitimately in flight. Leave it alone; it is a separate
      // concern this stale branch has no business touching.
      if (this.#approval !== approval) return;
    }

    this.#resolveApproval(verdict === 'yes');
    // `approval.from` is 'HEARING' when this permission request arrived while
    // a barge-in pause was still open (`#onPermission` captures `#state` at
    // request time, and `#onTurnEnd`'s resume branch deliberately leaves
    // AWAITING_APPROVAL untouched rather than clobber it in that case — see
    // its own comment). Restoring 'HEARING' verbatim there would leave
    // `#run`'s loop, still parked on `#bargeInResume` from the original
    // onset, stuck forever (a leak, exactly as `#releaseBargeIn`'s own doc
    // comment warns). Resume exactly as an ordinary non-stop recapture does:
    // back to SPEAKING, then release the pause so `#run` continues playing
    // the answer the approval interrupted.
    if (this.#pausedForBargeIn) {
      this.#setState('SPEAKING');
      this.#releaseBargeIn();
    } else {
      this.#setState(approval.from);
    }
    // The turn is still in flight — the tool call the approval was about now
    // runs (or was just denied and the agent carries on) inside the same
    // turn whose clock was paused for the wait (#onPermission). Add the
    // elapsed pause back onto the deadline (so the wait itself doesn't count
    // against the tool's budget) before resuming with the remaining time —
    // NOT a fresh turnTimeoutMs window (see #turnDeadline's comment).
    if (this.#approvalPauseStart !== undefined) {
      this.#turnDeadline =
        (this.#turnDeadline ?? this.#timers.now()) + (this.#timers.now() - this.#approvalPauseStart);
      this.#approvalPauseStart = undefined;
    }
    this.#armTurnTimer(this.#turnId);
  }

  async #redispatch(text: string): Promise<void> {
    // interrupt() is an await, and a barge-in, an audio failure or stop() can all
    // land inside it. Starting a turn out of whatever state that left behind
    // would answer a question the user never asked.
    const id = this.#turnId;
    await this.#interrupt();
    if (this.#turnId !== id) return;
    this.#ask(text);
  }

  /**
   * Bounded wrapper around `agent.interrupt()`. Both callers above await it
   * directly, outside `#run`, so `#turnTimer` cannot cover a hang here — and
   * the SDK gives no guarantee interrupt() returns promptly while a
   * background subagent Task is still working (spec: 2026-09-26, a barge-in
   * that froze the whole app because interrupt() never came back). Racing a
   * timer against it bounds the cost of a slow interrupt to one timeout
   * instead of the rest of the session.
   */
  async #interrupt(): Promise<void> {
    let timer: unknown;
    const timeout = new Promise<void>((resolve) => {
      timer = this.#timers.setTimeout(resolve, this.#deps.config.director.interruptTimeoutMs);
    });
    await Promise.race([this.#deps.agent.interrupt(), timeout]);
    this.#timers.clearTimeout(timer);
  }

  #resolveApproval(value: boolean): void {
    const approval = this.#approval;
    this.#approval = undefined;
    if (!approval) return;
    this.#timers.clearTimeout(approval.timer);
    approval.resolve(value);
  }

  /**
   * Wake `#run`'s loop out of a SPEAKING-onset pause without deciding
   * stop-vs-follow-up — used by every path that cancels a turn some OTHER
   * way (`stop()`, `#abandon()`, the approval timeout) while a mute might
   * still be waiting on `#onTurnEnd`'s decision. Without this, a turn killed
   * by one of those paths while paused would leave `#run` blocked on a
   * Promise nothing will ever resolve — a real leak, not just an unused
   * flag, since that suspended `#run` continuation (and everything it
   * closes over) is then unreachable but never collected as garbage,
   * without ever completing.
   */
  #releaseBargeIn(): void {
    this.#pausedForBargeIn = false;
    this.#bargeInHeard = undefined;
    this.#bargeInResume?.();
    this.#bargeInResume = undefined;
  }

  // -------------------------------------------------------------------- error

  /** Drop whatever is in flight, report the detail, say the short version. */
  #abandon(message: string, line: string): void {
    this.#deps.onError?.(message);
    this.#turnId++;
    this.#tts?.abort();
    this.#stopProgress();
    this.#stopTurnTimer();
    this.#resolveApproval(false);
    this.#releaseBargeIn();
    // The turn that would have drained this is dead, and an apology is about
    // to be spoken in its place — nothing queued against it belongs after that.
    this.#queued = [];
    // Dropping the turn locally is not enough: the agent keeps working, and its
    // result lands inside whatever turn comes next and ends it early.
    void this.#deps.agent.interrupt();
    this.#setState('LISTENING');
    void this.#say(line);
  }
}
