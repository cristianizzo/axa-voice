import { spawn, type ChildProcess } from 'node:child_process';
import type { AudioFrame, AudioInput, AudioOutput, Unsubscribe } from '../types.ts';
import type { Config } from '../config.ts';
import { encodeCommand, EventParser, PcmParser } from './protocol.ts';

/** The helper must announce itself quickly; it starts the audio unit before
 *  anything that could block. Hanging here is the launch failure spec §6 warns
 *  about, so it is turned into an error the user can be told about. */
const READY_TIMEOUT_MS = 5000;

/** How long `stop()` waits for a clean exit before killing the process. */
const STOP_GRACE_MS = 500;

/**
 * Capture, playback and echo cancellation. One class implements both `AudioInput`
 * and `AudioOutput` because underneath there is one `AUVoiceProcessor`: bus 1 is
 * the microphone, bus 0 is the speaker, and AEC needs the playback signal as its
 * reference (spec §3). Two objects would mean two audio units, which cannot
 * coexist on one device.
 *
 * Sample rates differ by direction, and this is forced by the unit:
 *  - `onFrame` delivers `config.audio.frameRate` (16 kHz), `frameSamples` per frame.
 *  - `enqueue` takes `config.audio.deviceRate` (24 kHz) frames, which is what the
 *    TTS produces, so playback needs no resampling anywhere.
 */
export class AudioDevice implements AudioInput, AudioOutput {
  readonly #config: Config;
  readonly #spawnFn: typeof spawn;
  #proc: ChildProcess | undefined;
  #frameHandlers = new Set<(f: AudioFrame) => void>();
  #errorHandlers = new Set<(m: string) => void>();
  #pendingFlushes = new Map<number, (r: { heardMs: number }) => void>();
  #flushSeq = 0;
  /** Wall clock at which the audio handed to the helper will have finished. */
  #playingUntil = 0;

  constructor(config: Config, opts: { spawnFn?: typeof spawn } = {}) {
    this.#config = config;
    this.#spawnFn = opts.spawnFn ?? spawn;
  }

  async start(): Promise<void> {
    const { helperPath, deviceRate, frameRate, frameSamples } = this.#config.audio;
    const proc = this.#spawnFn(
      helperPath,
      ['--rate', String(deviceRate), '--mic-rate', String(frameRate)],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.#proc = proc;

    const pcm = new PcmParser(frameSamples);
    proc.stdout!.on('data', (chunk: Buffer) => {
      for (const frame of pcm.push(chunk)) {
        for (const handler of this.#frameHandlers) handler(frame);
      }
    });

    const events = new EventParser();
    return new Promise<void>((resolve, reject) => {
      const onExit = (code: number | null) =>
        reject(new Error(`audio helper exited with code ${code} before becoming ready`));
      const onSpawnError = (err: Error) =>
        reject(new Error(`audio helper could not be started: ${err.message}`));
      const timer = setTimeout(
        () => reject(new Error(`audio helper did not become ready within ${READY_TIMEOUT_MS}ms`)),
        READY_TIMEOUT_MS,
      );
      timer.unref();
      proc.once('exit', onExit);
      proc.once('error', onSpawnError);

      proc.stderr!.on('data', (chunk: Buffer) => {
        for (const event of events.push(chunk)) {
          switch (event.type) {
            case 'ready':
              clearTimeout(timer);
              proc.off('exit', onExit);
              proc.off('error', onSpawnError);
              // After startup a death is no longer a rejected promise: nobody is
              // awaiting start() any more, so it has to be spoken (spec §9).
              proc.once('exit', (code) =>
                this.#fail(`audio helper exited unexpectedly with code ${code}`),
              );
              resolve();
              break;
            case 'flushed':
              this.#resolveFlushes(event.seq, event.heardMs);
              break;
            case 'error':
              this.#fail(event.message);
              break;
            case 'malformed':
              this.#fail(`audio helper emitted an unparseable line: ${event.raw}`);
              break;
            default:
              break;
          }
        }
      });
    });
  }

  async stop(): Promise<void> {
    const proc = this.#proc;
    if (!proc) return;
    proc.stdin!.write(encodeCommand('Q'));
    this.#proc = undefined;
    this.#playingUntil = 0;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill();
        resolve();
      }, STOP_GRACE_MS);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  onFrame(cb: (frame: AudioFrame) => void): Unsubscribe {
    this.#frameHandlers.add(cb);
    return () => this.#frameHandlers.delete(cb);
  }

  onError(cb: (message: string) => void): Unsubscribe {
    this.#errorHandlers.add(cb);
    return () => this.#errorHandlers.delete(cb);
  }

  enqueue(frame: AudioFrame): void {
    const proc = this.#proc;
    if (!proc) return;
    const payload = Buffer.alloc(frame.length * 2);
    for (let i = 0; i < frame.length; i++) payload.writeInt16LE(frame[i]!, i * 2);
    proc.stdin!.write(encodeCommand('A', payload));
    const durationMs = (frame.length / this.#config.audio.deviceRate) * 1000;
    this.#playingUntil = Math.max(this.#playingUntil, Date.now()) + durationMs;
  }

  async flush(): Promise<{ heardMs: number }> {
    const proc = this.#proc;
    if (!proc) return { heardMs: 0 };
    const seq = ++this.#flushSeq;
    this.#playingUntil = 0;
    const settled = new Promise<{ heardMs: number }>((resolve) => {
      this.#pendingFlushes.set(seq, resolve);
    });
    proc.stdin!.write(encodeCommand('F'));
    return settled;
  }

  isPlaying(): boolean {
    return Date.now() < this.#playingUntil;
  }

  /**
   * Resolve every flush up to `seq`, not only the exact match. The render
   * callback collapses requests that arrive inside the same callback and acks
   * once with the highest sequence number, so an exact-match map would leave the
   * earlier flush pending for ever — and the Director awaits flush() before it
   * can listen to the user again.
   */
  #resolveFlushes(seq: number, heardMs: number): void {
    for (const [pending, resolve] of this.#pendingFlushes) {
      if (pending > seq) continue;
      this.#pendingFlushes.delete(pending);
      resolve({ heardMs });
    }
  }

  #fail(message: string): void {
    for (const handler of this.#errorHandlers) handler(message);
  }
}
