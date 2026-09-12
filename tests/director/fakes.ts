import type { Config } from '../../src/config.ts';
import type { DirectorDeps, Timers } from '../../src/director/director.ts';
import { SentenceSpeechFilter } from '../../src/filter/speech-filter.ts';
import type {
  AgentEvent,
  AgentSession,
  AudioFrame,
  AudioInput,
  AudioOutput,
  PermissionRequest,
  Transcriber,
  TranscriptionStream,
  TurnDetector,
  Unsubscribe,
  Voice,
} from '../../src/types.ts';

/**
 * Every fake records what it was asked to do and exposes a manual trigger, so a
 * test drives the Director the way the world would: an event at a time, with no
 * sleeping. Time is injected too — an approval timeout measured with a real
 * clock would make the suite take ten seconds and still be flaky.
 */

class FakeTimers implements Timers {
  #now = 0;
  #next = 1;
  readonly #pending = new Map<number, { at: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): unknown {
    const handle = this.#next++;
    this.#pending.set(handle, { at: this.#now + ms, fn });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.#pending.delete(handle as number);
  }

  /** Fire everything due, oldest first — a later timer must not jump the queue. */
  advance(ms: number): void {
    this.#now += ms;
    for (;;) {
      const due = [...this.#pending.entries()]
        .filter(([, timer]) => timer.at <= this.#now)
        .sort((a, b) => a[1].at - b[1].at);
      const first = due[0];
      if (!first) return;
      this.#pending.delete(first[0]);
      first[1].fn();
    }
  }
}

class FakeAudioInput implements AudioInput {
  started = false;
  readonly #frameHandlers = new Set<(frame: AudioFrame) => void>();
  readonly #errorHandlers = new Set<(message: string) => void>();

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  onFrame(cb: (frame: AudioFrame) => void): Unsubscribe {
    this.#frameHandlers.add(cb);
    return () => this.#frameHandlers.delete(cb);
  }

  onError(cb: (message: string) => void): Unsubscribe {
    this.#errorHandlers.add(cb);
    return () => this.#errorHandlers.delete(cb);
  }

  /** Deliver one frame of audible level. */
  frame(samples = 320): void {
    const frame = new Int16Array(samples).fill(4000);
    for (const handler of this.#frameHandlers) handler(frame);
  }

  fail(message: string): void {
    for (const handler of this.#errorHandlers) handler(message);
  }
}

class FakeAudioOutput implements AudioOutput {
  /** Settable: a test decides how much of the answer the user actually heard. */
  heardMs = 0;
  flushes = 0;
  readonly frames: AudioFrame[] = [];

  enqueue(frame: AudioFrame): void {
    this.frames.push(frame);
  }

  async flush(): Promise<{ heardMs: number }> {
    this.flushes++;
    return { heardMs: this.heardMs };
  }

  isPlaying(): boolean {
    return false;
  }
}

class FakeStream implements TranscriptionStream {
  closed = false;
  readonly pushed: AudioFrame[] = [];
  readonly #partialHandlers = new Set<(text: string) => void>();
  readonly #finalHandlers = new Set<(text: string) => void>();

  push(frame: AudioFrame): void {
    this.pushed.push(frame);
  }

  onPartial(cb: (text: string) => void): Unsubscribe {
    this.#partialHandlers.add(cb);
    return () => this.#partialHandlers.delete(cb);
  }

  onFinal(cb: (text: string) => void): Unsubscribe {
    this.#finalHandlers.add(cb);
    return () => this.#finalHandlers.delete(cb);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  emitPartial(text: string): void {
    for (const handler of this.#partialHandlers) handler(text);
  }

  emitFinal(text: string): void {
    for (const handler of this.#finalHandlers) handler(text);
  }
}

class FakeTranscriber implements Transcriber {
  readonly opened: FakeStream[] = [];

  async open(): Promise<TranscriptionStream> {
    const stream = new FakeStream();
    this.opened.push(stream);
    return stream;
  }

  get current(): FakeStream | undefined {
    return this.opened.at(-1);
  }

  partial(text: string): void {
    this.current?.emitPartial(text);
  }

  final(text: string): void {
    this.current?.emitFinal(text);
  }
}

class FakeTurnDetector implements TurnDetector {
  readonly pushed: { frame: AudioFrame; partialText: string | null }[] = [];
  readonly #startHandlers = new Set<() => void>();
  readonly #endHandlers = new Set<() => void>();

  push(frame: AudioFrame, partialText: string | null): void {
    this.pushed.push({ frame, partialText });
  }

  onSpeechStart(cb: () => void): Unsubscribe {
    this.#startHandlers.add(cb);
    return () => this.#startHandlers.delete(cb);
  }

  onTurnEnd(cb: () => void): Unsubscribe {
    this.#endHandlers.add(cb);
    return () => this.#endHandlers.delete(cb);
  }

  speechStart(): void {
    for (const handler of this.#startHandlers) handler();
  }

  turnEnd(): void {
    for (const handler of this.#endHandlers) handler();
  }
}

class FakeAgentSession implements AgentSession {
  readonly sent: string[] = [];
  interrupts = 0;
  interruptionNote: { spokenSoFar: string; userSaid: string } | undefined;

  #handler: ((req: PermissionRequest) => Promise<boolean>) | undefined;
  #queue: AgentEvent[] = [];
  #ended = false;
  #wake: (() => void) | undefined;

  async *send(text: string): AsyncIterable<AgentEvent> {
    this.sent.push(text);
    this.#queue = [];
    this.#ended = false;
    for (;;) {
      const event = this.#queue.shift();
      if (event) {
        yield event;
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }

  /**
   * Mirrors ClaudeAgentSession: a text block ends with a '\n' delta, because a
   * sentence with no trailing whitespace is invisible to a sentence splitter.
   */
  emitText(text: string): void {
    this.#push({ type: 'text', delta: text });
    this.#push({ type: 'text', delta: '\n' });
  }

  emitTool(name: string, phase: 'start' | 'end'): void {
    this.#push({ type: 'tool', name, phase });
  }

  emitDone(): void {
    this.#push({ type: 'done' });
    this.#ended = true;
    this.#notify();
  }

  async interrupt(): Promise<void> {
    this.interrupts++;
    this.#ended = true;
    this.#notify();
  }

  notifyInterruption(spokenSoFar: string, userSaid: string): void {
    this.interruptionNote = { spokenSoFar, userSaid };
  }

  onPermissionRequest(handler: (req: PermissionRequest) => Promise<boolean>): void {
    this.#handler = handler;
  }

  /** Stands in for the SDK's canUseTool callback. */
  requestPermission(req: PermissionRequest): Promise<boolean> {
    if (!this.#handler) throw new Error('the Director never registered a permission handler');
    return this.#handler(req);
  }

  #push(event: AgentEvent): void {
    this.#queue.push(event);
    this.#notify();
  }

  #notify(): void {
    this.#wake?.();
    this.#wake = undefined;
  }
}

/**
 * Roughly the pace of Italian speech. The exact figure does not matter; what
 * matters is that a long sentence produces proportionally more audio, because
 * that is what the Director maps `heardMs` back onto.
 */
const MS_PER_CHAR = 70;
const FRAME_MS = 20;

class FakeVoice implements Voice {
  readonly spoken: string[] = [];
  aborts = 0;
  prewarms = 0;
  closes = 0;

  readonly #config: Config;

  constructor(config: Config) {
    this.#config = config;
  }

  prewarm(): void {
    this.prewarms++;
  }

  close(): void {
    this.closes++;
  }

  async *synthesize(
    text: AsyncIterable<string>,
    signal: AbortSignal,
  ): AsyncIterable<AudioFrame> {
    if (signal.aborted) return;
    signal.addEventListener('abort', () => this.aborts++, { once: true });

    const samples = Math.round((this.#config.audio.deviceRate * FRAME_MS) / 1000);
    for await (const sentence of text) {
      if (signal.aborted) return;
      this.spoken.push(sentence);
      const frames = Math.max(1, Math.round((sentence.length * MS_PER_CHAR) / FRAME_MS));
      for (let i = 0; i < frames; i++) {
        if (signal.aborted) return;
        yield new Int16Array(samples).fill(1000);
      }
    }
  }
}

export function makeFakes(config: Config) {
  const audioIn = new FakeAudioInput();
  const audioOut = new FakeAudioOutput();
  const transcriber = new FakeTranscriber();
  const turns = new FakeTurnDetector();
  const agent = new FakeAgentSession();
  const voice = new FakeVoice(config);
  const timers = new FakeTimers();
  const errors: string[] = [];

  const deps: DirectorDeps = {
    config,
    audioIn,
    audioOut,
    transcriber,
    turns,
    agent,
    voice,
    // The filter is pure, so there is no reason to fake it — and faking it would
    // hide the seam where a block-final sentence is released.
    filter: new SentenceSpeechFilter(),
    timers,
    onError: (message) => errors.push(message),
  };

  return {
    deps,
    audioIn,
    audioOut,
    transcriber,
    turns,
    agent,
    voice,
    errors,
    advance: (ms: number) => timers.advance(ms),
    /**
     * Drain the microtask queue. The pipeline is four chained async generators
     * deep (agent -> filter -> voice -> playback), so one turn of the loop is
     * not enough to settle it.
     */
    tick: async (): Promise<void> => {
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}
