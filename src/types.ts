export type AudioFrame = Int16Array;
export type Unsubscribe = () => void;

/** Mic capture with acoustic echo cancellation. Same device as AudioOutput. */
export interface AudioInput {
  start(): Promise<void>;
  stop(): Promise<void>;
  onFrame(cb: (frame: AudioFrame) => void): Unsubscribe;
}

/** Playback queue that can be silenced instantly. Same device as AudioInput. */
export interface AudioOutput {
  enqueue(frame: AudioFrame): void;
  /** Drop queued audio, silence within 50ms, and report what was actually HEARD. */
  flush(): Promise<{ heardMs: number }>;
  isPlaying(): boolean;
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
