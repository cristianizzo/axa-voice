import type { Config } from '../config.ts';
import { clean } from '../stt/clean.ts';
import { toSpokenForm } from '../filter/speech-filter.ts';
import { interpretApproval, isStopCommand } from './approval.ts';
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
  sinks?: OutputSink[];
  timers?: Timers;
  /** Where technical detail goes. The user hears a short line instead. */
  onError?: (message: string) => void;
}

const systemTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * Rotated rather than picked at random: hearing the same filler twice in a row
 * is the single most robotic thing a voice assistant does.
 */
const FILLERS = [
  'Un attimo che guardo.',
  'Aspetta un secondo.',
  'Dammi un attimo che controllo.',
];

const GAVE_UP = 'Va bene, lascio stare. Non ho sentito la risposta.';
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
 * How often to say something while a tool runs. Long enough not to nag, short
 * enough that the user never wonders whether the thing is still alive.
 */
const PROGRESS_EVERY_MS = 3000;

async function only(text: string): Promise<AsyncIterable<string>> {
  return (async function* () {
    yield text;
  })();
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
   * True whenever the turn detector reports the user speaking, independent of
   * `#state`. `#state` answers what the agent is doing; this answers whether
   * the user is being recorded — the two used to be the same question, which is
   * exactly what let a follow-up during THINKING look like a cancellation.
   */
  #capturing = false;
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
  #fillerTimer: unknown;
  #fillerIndex = 0;
  /** Armed while a tool is running, re-armed after every line it speaks. */
  #progressTimer: unknown;
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

  /** Sentences handed to the voice this turn. */
  #spoken: string[] = [];

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
   * frame — a filler, an approval question. A line spoken while the answer is
   * already running, which is what narrating a tool call is, lands inside the
   * answer's stretch of the timeline and would otherwise inflate its measured
   * duration, skewing the prefix even though `#answerFromMs` never moved.
   */
  #asideMs = 0;

  /** What the user heard before cutting in, waiting for what they say next. */
  #pendingNote: string | undefined;

  #approval:
    | { resolve: (value: boolean) => void; from: DirectorState; timer: unknown }
    | undefined;

  constructor(deps: DirectorDeps) {
    this.#deps = deps;
    this.#timers = deps.timers ?? systemTimers;
  }

  get state(): DirectorState {
    return this.#state;
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
    this.#state = 'LISTENING';
  }

  async stop(): Promise<void> {
    for (const off of this.#unsubscribe.splice(0)) off();
    this.#turnId++;
    this.#tts?.abort();
    this.#stopFiller();
    this.#stopProgress();
    this.#resolveApproval(false);
    // Nothing is coming back to drain this session's queue.
    this.#queued = [];

    const stream = this.#stream;
    this.#stream = undefined;
    await stream?.close();
    await this.#deps.audioIn.stop();
    this.#deps.voice.close?.();
    this.#state = 'LISTENING';
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
    stream.onFinal((text) => {
      this.#lastFinal = text;
    });
    this.#stream = stream;
  }

  #onFrame(frame: AudioFrame): void {
    // The detector first: it may turn this very frame into a speech onset, and
    // the frame that crossed the threshold is one whisper needs.
    this.#deps.turns.push(frame, this.#lastPartial);
    // Capture is now independent of `#state`. THINKING must be able to record
    // the user without ceasing to be THINKING: what they say is a follow-up,
    // not a cancellation. Gating on `#capturing` alone is still what keeps
    // whisper from transcribing an empty room during LISTENING.
    if (this.#capturing) this.#stream?.push(frame);
  }

  #onSpeechStart(): void {
    this.#capturing = true;
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
    this.#state = 'HEARING';
    if (wasSpeaking) void this.#bargeIn();
  }

  async #bargeIn(): Promise<void> {
    this.#turnId++;
    this.#stopFiller();
    this.#stopProgress();
    this.#tts?.abort();
    // A fresh utterance that barges in supersedes the turn it cut off — and
    // anything that turn had queued from an earlier follow-up. Keeping it
    // would answer stale words after the turn the user actually asked for.
    this.#queued = [];

    const { heardMs } = await this.#deps.audioOut.flush();
    this.#pendingNote = this.#heardPrefix(heardMs);

    // interrupt(), not abort(): aborting tears the session down and costs ~2s.
    await this.#deps.agent.interrupt();
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
   * a filler, an approval question — is not part of the answer. Neither is
   * audio the Director spoke *during* the answer, which is what `#asideMs`
   * removes: `#answerFromMs` cannot see it, because it is already behind it.
   */
  #heardPrefix(heardMs: number): string {
    const text = this.#spoken.join(' ');
    const answerMs = this.#enqueuedMs - this.#answerFromMs - this.#asideMs;
    if (!text || answerMs <= 0) return '';

    // `#asideMs` counts aside audio enqueued, not rendered, so barging in
    // mid-aside subtracts a full aside the user only partly heard, and
    // `heardOfAnswer` under-counts by the unplayed remainder. That is the safe
    // direction: §6 exists to stop the note from claiming the user heard more
    // than they did, and a short prefix does not. The `Math.min` below is an
    // upper clamp against `answerMs` — it has nothing to do with this case.
    const heardOfAnswer = Math.min(heardMs - this.#answerFromMs - this.#asideMs, answerMs);
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
    // The utterance is over whatever it turns out to be, so capture stops here
    // — on every path out of this method, including the ones that route
    // nothing. Cleared up front rather than once a route has been chosen
    // because every route below has an await in it: leaving it set across that
    // await is what would feed whisper for the rest of the answer, and setting
    // it after would clobber a fresh onset that arrived inside the await.
    this.#capturing = false;

    // A turn still in flight. THINKING is the obvious case; SPEAKING is reached
    // when speech that began while the agent was working outlasts the answer's
    // first sentence, because #run flips the state the moment that sentence
    // exists. Under an ordinary barge-in the state is already HEARING by the
    // time a transcript exists, so this branch only ever sees capture that
    // began while the agent was working — a follow-up, routed as one. §1's
    // table omits SPEAKING only because it assumed barge-in had already moved
    // the state to HEARING; that does not hold for capture that started
    // earlier, and dropping the utterance here is how it gets lost.
    if (this.#state === 'THINKING' || this.#state === 'SPEAKING') {
      const id = this.#turnId;
      const said = await this.#takeFinal();
      // Forcing the final transcription is a round trip; a barge-in, an audio
      // failure or stop() can all land inside it.
      if (this.#turnId !== id) return;
      if (isStopCommand(said)) {
        this.#turnId++;
        this.#tts?.abort();
        this.#stopFiller();
        // "basta" said into a running search has to silence the search's own
        // narration too, or the cancelled turn keeps talking for three seconds.
        this.#stopProgress();
        // A permission request can have arrived inside the await above without
        // bumping #turnId. Leaving it unresolved strands the SDK's canUseTool
        // promise with its timer armed, and approvalTimeoutMs later it speaks
        // GAVE_UP into a moment that has nothing to do with it.
        this.#resolveApproval(false);
        void this.#deps.agent.interrupt();
        this.#state = 'LISTENING';
        // A stop word cancels the line of thought it interrupted. Anything
        // still waiting from earlier in that same line must not resurrect once
        // the next, unrelated turn is done answering.
        this.#queued = [];
        return;
      }
      if (said) this.#queued.push(said); // Drained at the end of #run.
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
      this.#answer(text);
      return;
    }
    if (!text) {
      // A cough that whisper turned into "[Musica]" is not a turn.
      this.#state = 'LISTENING';
      return;
    }
    this.#ask(text);
  }

  /** Close the stream to force the final transcription, then open the next one. */
  async #takeFinal(): Promise<string> {
    const stream = this.#stream;
    this.#stream = undefined;
    await stream?.close();
    const text = clean(this.#lastFinal);
    await this.#openStream();
    return text;
  }

  // ------------------------------------------------------------------ talking

  #ask(text: string): void {
    const note = this.#pendingNote;
    this.#pendingNote = undefined;
    if (note !== undefined) this.#deps.agent.notifyInterruption(note, text);

    this.#state = 'THINKING';
    this.#startFiller();
    void this.#run(text);
  }

  async #run(text: string): Promise<void> {
    const id = ++this.#turnId;
    const tts = new AbortController();
    this.#tts = tts;
    this.#spoken = [];
    // Provisional: #play moves it to where the answer's first frame actually
    // lands, so a filler played in between is not counted as answer.
    this.#answerFromMs = this.#enqueuedMs;
    this.#asideMs = 0;
    this.#toolsRunning = 0;

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
        director.#stopFiller();
        // The answer itself is now the thing covering the silence.
        director.#stopProgress();
        director.#spoken.push(sentence);
        if (director.#state === 'THINKING') director.#state = 'SPEAKING';
        yield sentence;
      }
    })();

    try {
      await this.#play(sentences, tts.signal, id);
    } catch (error) {
      if (this.#turnId === id) this.#abandon(`turn failed: ${String(error)}`, TURN_FAILED);
      return;
    }

    if (this.#turnId !== id) return;
    this.#stopFiller();
    // A stream that ends inside a tool bracket — an interrupt, a crashed tool —
    // leaves the timer armed with nothing left to narrate.
    this.#stopProgress();
    this.#state = 'LISTENING';

    // Said while the answer was in flight. It was deliberately not allowed to
    // interrupt, so it must not be silently dropped either.
    const next = this.#queued.shift();
    if (next !== undefined) this.#ask(next);
  }

  async #play(sentences: AsyncIterable<string>, signal: AbortSignal, id: number): Promise<void> {
    const sinks = this.#deps.sinks ?? [];
    let started = false;

    for await (const frame of this.#deps.voice.synthesize(sentences, signal)) {
      if (signal.aborted || this.#turnId !== id) break;
      if (!started) {
        started = true;
        this.#answerFromMs = this.#enqueuedMs;
        // Everything the Director said up to here is already behind the mark.
        this.#asideMs = 0;
        for (const sink of sinks) sink.onSpeechStart();
      }
      await this.#waitForRoom(signal, id);
      if (signal.aborted || this.#turnId !== id) break;
      this.#emit(frame, sinks, 'answer');
    }

    if (started) for (const sink of sinks) sink.onSpeechEnd();
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
    if (kind === 'aside') this.#asideMs += ms;
    this.#deps.audioOut.enqueue(frame);
    for (const sink of sinks) sink.onAudio(frame);
  }

  /** Speak one line the Director wrote itself: a filler, a question, an apology. */
  async #say(line: string): Promise<void> {
    const sinks = this.#deps.sinks ?? [];
    // One at a time. Two of these overlapping — a filler running into an
    // approval question, or two questions back to back — is not a degraded
    // answer, it is an unintelligible one.
    this.#line?.abort();
    const controller = new AbortController();
    this.#line = controller;

    try {
      const source = await only(toSpokenForm(line));
      for await (const frame of this.#deps.voice.synthesize(source, controller.signal)) {
        if (controller.signal.aborted) break;
        this.#emit(frame, sinks, 'aside');
      }
    } catch (error) {
      // A filler that fails is not worth killing the turn for, but it is worth
      // saying out loud in the log — a voice that silently stops speaking is
      // indistinguishable from one that has nothing to say.
      this.#deps.onError?.(`voice: ${String(error)}`);
    } finally {
      if (this.#line === controller) this.#line = undefined;
    }
  }

  #startFiller(): void {
    this.#stopFiller();
    this.#fillerTimer = this.#timers.setTimeout(() => {
      this.#fillerTimer = undefined;
      // The first token may have landed while the timer was queued. Speaking
      // now would be the agent talking over its own answer.
      if (this.#state !== 'THINKING') return;
      void this.#say(FILLERS[this.#fillerIndex++ % FILLERS.length]!);
    }, this.#deps.config.director.fillerAfterMs);
  }

  /**
   * Stop the filler whether it is still pending or already out loud. Cancelling
   * only the timer leaves a filler that started a moment earlier talking over
   * the answer it was covering for.
   */
  #stopFiller(): void {
    if (this.#fillerTimer !== undefined) {
      this.#timers.clearTimeout(this.#fillerTimer);
      this.#fillerTimer = undefined;
    }
    this.#line?.abort();
    this.#line = undefined;
  }

  /**
   * Narrate a tool call for as long as it runs.
   *
   * The filler covers the wait for the first token and is cancelled by the
   * first sentence; the tool then runs behind that sentence, covered by
   * nothing. A web search is minutes of it — the silence that started this
   * project. Unlike the filler this repeats, because the wait it is covering
   * has no known length.
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
   * Same reasoning as `#stopFiller`, and the same channel: a progress line
   * already out loud has to be cut, not merely un-scheduled, or it talks over
   * the answer that has just arrived to replace it.
   */
  #stopProgress(): void {
    if (this.#progressTimer !== undefined) {
      this.#timers.clearTimeout(this.#progressTimer);
      this.#progressTimer = undefined;
    }
    this.#line?.abort();
    this.#line = undefined;
  }

  // ----------------------------------------------------------------- approval

  #onPermission(req: PermissionRequest): Promise<boolean> {
    // A second request while one is outstanding can only come from the turn we
    // were already thinking about.
    const from = this.#state === 'AWAITING_APPROVAL' ? 'THINKING' : this.#state;
    this.#resolveApproval(false);
    this.#stopFiller();

    return new Promise<boolean>((resolve) => {
      const timer = this.#timers.setTimeout(() => {
        this.#resolveApproval(false);
        // The user walked away. Abandoning the turn is kinder than leaving a
        // half-finished answer to arrive at an empty room.
        this.#turnId++;
        this.#tts?.abort();
        // This #run will never reach the drain at the end of it — it's being
        // abandoned right here — so anything it had queued would otherwise sit
        // forgotten until surfacing, unasked-for, after a later turn.
        this.#queued = [];
        // The agent is still working on the turn nobody is waiting for, and its
        // result would otherwise surface in the middle of the next one.
        void this.#deps.agent.interrupt();
        this.#state = 'LISTENING';
        void this.#say(GAVE_UP);
      }, this.#deps.config.director.approvalTimeoutMs);

      this.#approval = { resolve, from, timer };
      this.#state = 'AWAITING_APPROVAL';
      void this.#say(`Posso ${req.summary}?`);
    });
  }

  #answer(text: string): void {
    const approval = this.#approval;
    if (!approval) return;

    const verdict = interpretApproval(text);
    this.#resolveApproval(verdict === 'yes');

    // 'unclear' is a denial AND a new turn. Denying without re-dispatching
    // loses what the user said, which feels exactly like being ignored (§8).
    if (verdict === 'unclear' && text) {
      this.#state = 'HEARING';
      void this.#redispatch(text);
      return;
    }
    this.#state = approval.from;
  }

  async #redispatch(text: string): Promise<void> {
    await this.#deps.agent.interrupt();
    this.#ask(text);
  }

  #resolveApproval(value: boolean): void {
    const approval = this.#approval;
    this.#approval = undefined;
    if (!approval) return;
    this.#timers.clearTimeout(approval.timer);
    approval.resolve(value);
  }

  // -------------------------------------------------------------------- error

  /** Drop whatever is in flight, report the detail, say the short version. */
  #abandon(message: string, line: string): void {
    this.#deps.onError?.(message);
    this.#turnId++;
    this.#tts?.abort();
    this.#stopFiller();
    this.#stopProgress();
    this.#resolveApproval(false);
    // The turn that would have drained this is dead, and an apology is about
    // to be spoken in its place — nothing queued against it belongs after that.
    this.#queued = [];
    // Dropping the turn locally is not enough: the agent keeps working, and its
    // result lands inside whatever turn comes next and ends it early.
    void this.#deps.agent.interrupt();
    this.#state = 'LISTENING';
    void this.#say(line);
  }
}
