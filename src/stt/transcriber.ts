import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AudioFrame, Transcriber, TranscriptionStream, Unsubscribe,
} from '../types.ts';
import type { Config } from '../config.ts';
import { clean } from './clean.ts';

/**
 * whisper-server rejects raw PCM; the payload must be a container.
 *
 * The return type is `Buffer<ArrayBuffer>`, not a bare `Buffer`: a bare `Buffer`
 * is `Buffer<ArrayBufferLike>`, which could be backed by a SharedArrayBuffer and
 * is therefore not a `BlobPart`. Narrowing here avoids copying the samples again
 * on every partial just to satisfy the Blob constructor.
 */
export function encodeWav(samples: Int16Array, rate: number): Buffer<ArrayBuffer> {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);           // fmt chunk size
  buffer.writeUInt16LE(1, 20);            // PCM
  buffer.writeUInt16LE(1, 22);            // mono
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);     // byte rate
  buffer.writeUInt16LE(2, 32);            // block align
  buffer.writeUInt16LE(16, 34);           // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) buffer.writeInt16LE(samples[i]!, 44 + i * 2);
  return buffer;
}

/**
 * Caps on a server that stops answering. Both exist because the Director awaits
 * close() before it can reply and shutdown awaits it too: an unbounded wait here
 * is not a slow transcript, it is a session that never speaks again.
 */
const REQUEST_TIMEOUT_MS = 10_000;
const CLOSE_WAIT_MS = 2_000;

/**
 * Silence gate for whisper.cpp's YouTube-subtitle hallucinations. Switching
 * stt.modelPath to large-v3-turbo (src/config.ts) made the model confidently
 * invent sign-off phrases (e.g. "Grazie a tutti") over near-silent/room-tone
 * audio instead of returning nothing. clean.ts catches known phrasings, but a
 * silence gate on the raw samples is a second, model-agnostic line of defense.
 *
 * Measured on real debug-audio dumps (2026-09-26, AXA_DEBUG=1 captures):
 *   - hallucinated/near-silent segments: RMS 172-388
 *   - real speech utterances this session: RMS 1133-4583
 * 600 sits with a comfortable margin above the hallucination band and well
 * below the real-speech band. Leaning low is deliberate: clean.ts's own
 * comment is clear that quiet-but-real short answers ("sì"/"no"/"ferma", the
 * whole approval vocabulary of spec §8) must never be silently swallowed, so
 * it is safer to occasionally let a quiet hallucination through to clean.ts's
 * phrase filter than to risk dropping a real short answer here.
 */
const SILENCE_RMS_THRESHOLD = 600;

function rms(samples: readonly number[]): number {
  if (!samples.length) return 0;
  let sumSquares = 0;
  for (const sample of samples) sumSquares += sample * sample;
  return Math.sqrt(sumSquares / samples.length);
}

export class WhisperTranscriber implements Transcriber {
  readonly #config: Config;
  readonly #fetchFn: typeof fetch;
  readonly #dumpDir: string | undefined;

  constructor(config: Config, opts: { fetchFn?: typeof fetch; dumpDir?: string } = {}) {
    this.#config = config;
    this.#fetchFn = opts.fetchFn ?? fetch;
    this.#dumpDir = opts.dumpDir;
  }

  async open(): Promise<TranscriptionStream> {
    return new WhisperStream(this.#config, this.#fetchFn, this.#dumpDir);
  }
}

class WhisperStream implements TranscriptionStream {
  readonly #config: Config;
  readonly #fetchFn: typeof fetch;
  readonly #dumpDir: string | undefined;
  readonly #partialHandlers = new Set<(t: string) => void>();
  readonly #finalHandlers = new Set<(t: string) => void>();
  #samples: number[] = [];
  #timer: NodeJS.Timeout;
  #busy = false;
  #closed = false;

  constructor(config: Config, fetchFn: typeof fetch, dumpDir: string | undefined) {
    this.#config = config;
    this.#fetchFn = fetchFn;
    this.#dumpDir = dumpDir;
    this.#timer = setInterval(() => void this.#tick(), config.stt.partialCadenceMs);
    // The partial loop must never hold the process open on its own: the Director
    // owns the lifetime, close() is what stops it.
    this.#timer.unref();
  }

  push(frame: AudioFrame): void {
    if (this.#closed) return;
    for (const sample of frame) this.#samples.push(sample);
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
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    // Wait out an in-flight partial: the server serializes, so racing it would
    // only make the final transcript slower (spec §5). Bounded, because a
    // partial that never comes back must not take the turn down with it.
    const until = Date.now() + CLOSE_WAIT_MS;
    while (this.#busy && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    const text = await this.#final();
    if (text) for (const handler of this.#finalHandlers) handler(text);
  }

  /**
   * The final transcription is the one that must not be lost. A dropped partial
   * is recoverable — the next tick sends the same buffered audio — but the final
   * has no next tick. Retry until it lands or the budget is spent; after that,
   * `''` keeps close() from throwing, which would reject the Director's turn end.
   */
  async #final(): Promise<string> {
    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    for (;;) {
      try {
        return await this.#transcribe(0);
      } catch {
        if (Date.now() >= deadline) return '';
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  async #tick(): Promise<void> {
    if (this.#busy || this.#closed || !this.#samples.length) return;
    try {
      const text = await this.#transcribe(this.#config.stt.partialAudioCtx);
      if (text && !this.#closed) {
        for (const handler of this.#partialHandlers) handler(text);
      }
    } catch {
      // A dropped partial is recoverable: the next tick sends the same audio.
    }
  }

  async #transcribe(audioCtx: number): Promise<string> {
    if (!this.#samples.length) return '';
    // Below this, it's room tone/background noise, not speech: skip the
    // network round trip entirely rather than hand whisper-server something
    // it is prone to hallucinate a confident sign-off over (see
    // SILENCE_RMS_THRESHOLD above).
    if (rms(this.#samples) < SILENCE_RMS_THRESHOLD) return '';
    this.#busy = true;
    try {
      const { port, language } = this.#config.stt;
      const wav = encodeWav(Int16Array.from(this.#samples), this.#config.audio.frameRate);

      const form = new FormData();
      form.set('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
      form.set('response_format', 'text');
      form.set('language', language);
      form.set('audio_ctx', String(audioCtx));

      const res = await this.#fetchFn(`http://127.0.0.1:${port}/inference`, {
        method: 'POST',
        body: form,
        // Without a deadline a hung request leaves #busy set for ever, and every
        // later tick and close() then waits on a partial that will never land.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        // The final is the one #final() retries on ANY throw, not just a
        // non-ok response — mirror that here so a dump exists for a request
        // whisper rejected outright, not only ones it mistranscribed.
        void this.#dump(audioCtx, wav, '');
        return '';
      }
      const text = clean(await res.text());
      void this.#dump(audioCtx, wav, text);
      return text;
    } finally {
      this.#busy = false;
    }
  }

  /**
   * Exists to catch the live-only bug a static-fixture test cannot reproduce
   * (2026-09-23: whisper produced garbled English for live Italian speech, but
   * transcribed a saved fixture correctly regardless of language). Only the
   * final transcription (`audioCtx === 0`) is dumped — partials fire every
   * `partialCadenceMs` and would flood the directory for no diagnostic gain.
   * Fire-and-forget and errors are swallowed: a full disk or missing directory
   * must not turn a debug aid into a reason the turn itself fails.
   */
  async #dump(audioCtx: number, wav: Buffer, text: string): Promise<void> {
    if (!this.#dumpDir || audioCtx !== 0) return;
    try {
      await mkdir(this.#dumpDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await writeFile(join(this.#dumpDir, `${stamp}.wav`), wav);
      await writeFile(join(this.#dumpDir, `${stamp}.txt`), text);
    } catch {
      // Diagnostic aid only — never let it be the reason a turn fails.
    }
  }
}
