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

export class WhisperTranscriber implements Transcriber {
  readonly #config: Config;
  readonly #fetchFn: typeof fetch;

  constructor(config: Config, opts: { fetchFn?: typeof fetch } = {}) {
    this.#config = config;
    this.#fetchFn = opts.fetchFn ?? fetch;
  }

  async open(): Promise<TranscriptionStream> {
    return new WhisperStream(this.#config, this.#fetchFn);
  }
}

class WhisperStream implements TranscriptionStream {
  readonly #config: Config;
  readonly #fetchFn: typeof fetch;
  readonly #partialHandlers = new Set<(t: string) => void>();
  readonly #finalHandlers = new Set<(t: string) => void>();
  #samples: number[] = [];
  #timer: NodeJS.Timeout;
  #busy = false;
  #closed = false;

  constructor(config: Config, fetchFn: typeof fetch) {
    this.#config = config;
    this.#fetchFn = fetchFn;
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
    // only make the final transcript slower (spec §5).
    while (this.#busy) await new Promise((r) => setTimeout(r, 10));
    const text = await this.#transcribe(0);
    if (text) for (const handler of this.#finalHandlers) handler(text);
  }

  async #tick(): Promise<void> {
    if (this.#busy || this.#closed || !this.#samples.length) return;
    const text = await this.#transcribe(this.#config.stt.partialAudioCtx);
    if (text && !this.#closed) {
      for (const handler of this.#partialHandlers) handler(text);
    }
  }

  async #transcribe(audioCtx: number): Promise<string> {
    if (!this.#samples.length) return '';
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
      });
      if (!res.ok) return '';
      return clean(await res.text());
    } catch {
      // A dropped partial is recoverable — the next tick sees the same audio.
      // The final transcription is the one that must not be lost, and close()
      // issues it separately.
      return '';
    } finally {
      this.#busy = false;
    }
  }
}
