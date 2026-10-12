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
  /**
   * `language` is whisper-server's own best guess for this final utterance,
   * ISO 639-1 where the server exposes one ('it', 'en', ...), or `''` if it
   * could not be determined at all (e.g. an unusually shaped server
   * response). `confidence` is the server's own probability for that guess
   * (0-1) when it exposes one, `undefined` otherwise — not every whisper.cpp
   * server build returns it (see transcriber.ts's `parseVerboseJson` doc
   * comment), so a caller that gates on it must treat `undefined` as "no
   * signal", not as "zero confidence".
   */
  onFinal(cb: (text: string, language: string, confidence: number | undefined) => void): Unsubscribe;
  /**
   * `currentLanguage`, when given, is the conversation's current sticky
   * language (director.ts's `#language`) — used as the explicit `language`
   * a short final (too little audio to bother auto-detecting) requests
   * instead of `'auto'`. Optional so a caller with no notion of a "current
   * language" (shutdown, tests) still gets the implementation's own default.
   */
  close(currentLanguage?: string): Promise<void>;
}

export interface TurnDetector {
  /**
   * `selfPlayActive` tells the detector whether the Director is currently
   * speaking through the same device this frame was captured from. AEC
   * suppresses most of that signal before it reaches here, but it is not
   * uniform: measured (spec 2026-09-11 §6) at +10.4-15.6 dB attenuation for
   * ordinary content against only +0.7 dB for a steady tone — some of what
   * the Director says gets barely suppressed at all, and it lands mid-frame
   * with no chance for the caller to filter it downstream, since a real
   * barge-in and a residual echo look identical by the time whisper sees the
   * audio. Optional, default false, so a caller that has never heard of
   * self-play (every existing test fake) keeps working unchanged.
   */
  push(frame: AudioFrame, partialText: string | null, selfPlayActive?: boolean): void;
  onSpeechStart(cb: () => void): Unsubscribe;
  onTurnEnd(cb: () => void): Unsubscribe;
}

export interface Voice {
  /**
   * `language` lets a caller override `config.voice.language` for this one
   * call, so a Director tracking a live language switch (spec: mid-conversation
   * language switch) can speak an answer back in whatever language it was
   * actually asked in without this class holding any conversation state of its
   * own. Optional, defaulting to the config value, so every existing caller
   * that has nothing to override keeps working unchanged.
   */
  synthesize(
    text: AsyncIterable<string>,
    signal: AbortSignal,
    language?: string,
  ): AsyncIterable<AudioFrame>;
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
