import type { Config } from '../config.ts';
import { clean } from '../stt/clean.ts';
import { toSpokenForm } from '../filter/speech-filter.ts';
import { interpretApproval } from './approval.ts';
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
   * Bumped whenever the current turn stops mattering — a new turn, a barge-in,
   * an abandoned approval. The pipeline is several async generators deep, so it
   * keeps running for a while after the decision to drop it; checking this
   * before every state change is what stops a dead turn from resurrecting.
   */
  #turnId = 0;
  #tts: AbortController | undefined;
  #fillerTimer: unknown;
  #fillerIndex = 0;

  /** Sentences handed to the voice this turn, and the audio they produced. */
  #spoken: string[] = [];
  #spokenMs = 0;

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
    this.#clearFiller();
    this.#resolveApproval(false);

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
    if (this.#state === 'HEARING' || this.#state === 'AWAITING_APPROVAL') {
      this.#stream?.push(frame);
    }
  }

  #onSpeechStart(): void {
    // Already listening: HEARING is mid-utterance, AWAITING_APPROVAL is waiting
    // for an answer. Neither is interrupted by the user starting to talk.
    if (this.#state === 'HEARING' || this.#state === 'AWAITING_APPROVAL') return;

    const wasAnswering = this.#state === 'THINKING' || this.#state === 'SPEAKING';
    this.#state = 'HEARING';
    if (wasAnswering) void this.#bargeIn();
  }

  async #bargeIn(): Promise<void> {
    this.#turnId++;
    this.#clearFiller();
    this.#tts?.abort();

    const { heardMs } = await this.#deps.audioOut.flush();
    this.#pendingNote = this.#heardPrefix(heardMs);

    // interrupt(), not abort(): aborting tears the session down and costs ~2s.
    await this.#deps.agent.interrupt();
  }

  /**
   * Map playback milliseconds back onto the text that produced them.
   *
   * `Voice` hands back one flat frame stream for the whole turn, so there is no
   * exact sentence-to-audio boundary to read. Proportion by character count is
   * the honest approximation: monotonic, and it errs towards telling Claude the
   * user heard LESS than they did, which is the safe direction — repeating a
   * sentence is a small annoyance, assuming one was heard is a wrong answer.
   */
  #heardPrefix(heardMs: number): string {
    const text = this.#spoken.join(' ');
    if (!text || this.#spokenMs <= 0) return '';
    if (heardMs >= this.#spokenMs) return text;

    const chars = Math.floor(text.length * (heardMs / this.#spokenMs));
    const boundary = text.lastIndexOf(' ', chars);
    return text.slice(0, boundary > 0 ? boundary : chars).trim();
  }

  async #onTurnEnd(): Promise<void> {
    if (this.#state !== 'HEARING' && this.#state !== 'AWAITING_APPROVAL') return;

    const text = await this.#takeFinal();
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
    this.#spokenMs = 0;

    const director = this;
    const sentences = (async function* () {
      for await (const sentence of director.#deps.filter.filter(director.#deps.agent.send(text))) {
        if (director.#turnId !== id) return;
        director.#clearFiller();
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
    this.#clearFiller();
    this.#state = 'LISTENING';
  }

  async #play(sentences: AsyncIterable<string>, signal: AbortSignal, id: number): Promise<void> {
    const sinks = this.#deps.sinks ?? [];
    let started = false;

    for await (const frame of this.#deps.voice.synthesize(sentences, signal)) {
      if (signal.aborted || this.#turnId !== id) break;
      if (!started) {
        started = true;
        for (const sink of sinks) sink.onSpeechStart();
      }
      this.#spokenMs += (frame.length / this.#deps.config.audio.deviceRate) * 1000;
      this.#deps.audioOut.enqueue(frame);
      for (const sink of sinks) sink.onAudio(frame);
    }

    if (started) for (const sink of sinks) sink.onSpeechEnd();
  }

  /** Speak one line the Director wrote itself: a filler, a question, an apology. */
  async #say(line: string, signal?: AbortSignal): Promise<void> {
    const sinks = this.#deps.sinks ?? [];
    const controller = signal ? undefined : new AbortController();
    try {
      const source = await only(toSpokenForm(line));
      for await (const frame of this.#deps.voice.synthesize(
        source,
        signal ?? controller!.signal,
      )) {
        this.#deps.audioOut.enqueue(frame);
        for (const sink of sinks) sink.onAudio(frame);
      }
    } catch (error) {
      // A filler that fails is not worth killing the turn for, but it is worth
      // saying out loud in the log — a voice that silently stops speaking is
      // indistinguishable from one that has nothing to say.
      this.#deps.onError?.(`voice: ${String(error)}`);
    }
  }

  #startFiller(): void {
    this.#clearFiller();
    this.#fillerTimer = this.#timers.setTimeout(() => {
      this.#fillerTimer = undefined;
      // The first token may have landed while the timer was queued. Speaking
      // now would be the agent talking over its own answer.
      if (this.#state !== 'THINKING') return;
      void this.#say(FILLERS[this.#fillerIndex++ % FILLERS.length]!, this.#tts?.signal);
    }, this.#deps.config.director.fillerAfterMs);
  }

  #clearFiller(): void {
    if (this.#fillerTimer === undefined) return;
    this.#timers.clearTimeout(this.#fillerTimer);
    this.#fillerTimer = undefined;
  }

  // ----------------------------------------------------------------- approval

  #onPermission(req: PermissionRequest): Promise<boolean> {
    // A second request while one is outstanding can only come from the turn we
    // were already thinking about.
    const from = this.#state === 'AWAITING_APPROVAL' ? 'THINKING' : this.#state;
    this.#resolveApproval(false);
    this.#clearFiller();

    return new Promise<boolean>((resolve) => {
      const timer = this.#timers.setTimeout(() => {
        this.#resolveApproval(false);
        // The user walked away. Abandoning the turn is kinder than leaving a
        // half-finished answer to arrive at an empty room.
        this.#turnId++;
        this.#tts?.abort();
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
    this.#clearFiller();
    this.#resolveApproval(false);
    this.#state = 'LISTENING';
    void this.#say(line);
  }
}
