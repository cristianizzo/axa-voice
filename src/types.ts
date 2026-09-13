export type AudioFrame = Int16Array;
export type Unsubscribe = () => void;

/** Mic capture with acoustic echo cancellation. Same device as AudioOutput. */
export interface AudioInput {
  start(): Promise<void>;
  stop(): Promise<void>;
  onFrame(cb: (frame: AudioFrame) => void): Unsubscribe;
  /**
   * A microphone that dies delivers digital silence, which is indistinguishable
   * from a quiet room. Without a way to report that, the app waits for a turn
   * that can never come (spec §9), so this is required, not optional.
   */
  onError(cb: (message: string) => void): Unsubscribe;
}

/** Playback queue that can be silenced instantly. Same device as AudioInput. */
export interface AudioOutput {
  enqueue(frame: AudioFrame): void;
  /**
   * Drop queued audio, silence within 50ms, and report what was actually HEARD.
   *
   * `heardMs` counts from the moment playback started existing, not from the
   * start of the current answer: the device has no idea what a turn is. Mapping
   * it back onto a turn's text is the caller's job.
   */
  flush(): Promise<{ heardMs: number }>;
  isPlaying(): boolean;
  /**
   * How much enqueued audio has not been played yet. Required, not a nicety: the
   * queue is finite, TTS delivers far faster than real time, and a caller that
   * enqueues a long answer without watching this loses its tail silently.
   */
  bufferedMs(): number;
}

export interface Transcriber {
  open(): Promise<TranscriptionStream>;
}

export interface TranscriptionStream {
  push(frame: AudioFrame): void;
  onPartial(cb: (text: string) => void): Unsubscribe;
  onFinal(cb: (text: string) => void): Unsubscribe;
  close(): Promise<void>;
}

export interface TurnDetector {
  push(frame: AudioFrame, partialText: string | null): void;
  onSpeechStart(cb: () => void): Unsubscribe;
  onTurnEnd(cb: () => void): Unsubscribe;
}

export interface Voice {
  synthesize(text: AsyncIterable<string>, signal: AbortSignal): AsyncIterable<AudioFrame>;
  /**
   * Open the connection the next turn will use, off the critical path. Measured
   * at 458-500ms for Cartesia, and it does NOT amortise: a voice with a cold
   * socket pays it on every single turn. Optional because a local or offline
   * voice has nothing to warm.
   */
  prewarm?(): void;
  /** Release whatever prewarm() reserved. Optional for the same reason. */
  close?(): void;
}

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; phase: 'start' | 'end' }
  | { type: 'done' };

/** What the Director must be able to say out loud in one short line. */
export interface PermissionRequest {
  tool: string;
  /** Already in spoken form per spec §7 — "session.ts, dentro auth", not a full path. */
  summary: string;
}

export interface AgentSession {
  send(text: string): AsyncIterable<AgentEvent>;
  /** Stop the turn, keep the session usable. NOT an abort — see spec §6. */
  interrupt(): Promise<void>;
  notifyInterruption(spokenSoFar: string, userSaid: string): void;
  onPermissionRequest(handler: (req: PermissionRequest) => Promise<boolean>): void;
}

export interface SpeechFilter {
  filter(events: AsyncIterable<AgentEvent>): AsyncIterable<string>;
}

export interface OutputSink {
  onAudio(frame: AudioFrame): void;
  onSpeechStart(): void;
  onSpeechEnd(): void;
}
