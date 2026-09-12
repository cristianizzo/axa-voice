import type { AudioFrame } from '../types.ts';

/**
 * Wire protocol of the `native/aecio` helper.
 *
 *   stdin  : framed commands [1 byte cmd]['A'|'F'|'Q'][4 bytes LE length][payload]
 *   stdout : raw PCM16LE mono at the mic rate, continuous, NO framing
 *   stderr : one JSON object per line
 *
 * Kept in its own module, free of any process handling, so the framing can be
 * tested exhaustively without a microphone. Framing bugs diagnosed through an
 * audio device are miserable to find.
 */

/** The discriminated union of aecio's stderr JSON. Extra diagnostic fields the
 *  helper also emits are deliberately not modelled: nothing above consumes them. */
export type HelperEvent =
  | { type: 'ready'; rate: number; micRate: number }
  | { type: 'aec'; enabled: boolean }
  | { type: 'stats'; renderMaxGapMs: number; playRingMs: number; framesConsumed: number }
  | { type: 'flushed'; seq: number; heardMs: number; consumedMs: number; renderReactionMs: number }
  | { type: 'overflow' }
  | { type: 'error'; message: string }
  | { type: 'stopped' }
  | { type: 'malformed'; raw: string };

export function encodeCommand(cmd: 'A' | 'F' | 'Q', payload?: Buffer): Buffer {
  const body = payload ?? Buffer.alloc(0);
  const header = Buffer.alloc(5);
  header.write(cmd, 0, 'ascii');
  header.writeUInt32LE(body.length, 1);
  return Buffer.concat([header, body]);
}

/** Line-delimited JSON on stderr, tolerant of arbitrary chunk boundaries. */
export class EventParser {
  #buffer = '';

  push(chunk: Buffer): HelperEvent[] {
    this.#buffer += chunk.toString('utf8');
    const events: HelperEvent[] = [];
    let index: number;
    while ((index = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as HelperEvent);
      } catch {
        // Never swallow: an unparseable line means the helper is misbehaving,
        // and a silent drop here looks like a dead microphone (spec §9).
        events.push({ type: 'malformed', raw: line });
      }
    }
    return events;
  }
}

/** Raw PCM16LE with no framing; chunk boundaries may split a sample. */
export class PcmParser {
  #carry = Buffer.alloc(0);
  readonly #bytesPerFrame: number;

  constructor(samplesPerFrame: number) {
    this.#bytesPerFrame = samplesPerFrame * 2;
  }

  push(chunk: Buffer): AudioFrame[] {
    const data = this.#carry.length ? Buffer.concat([this.#carry, chunk]) : chunk;
    const frames: AudioFrame[] = [];
    let offset = 0;
    while (data.length - offset >= this.#bytesPerFrame) {
      const frame = new Int16Array(this.#bytesPerFrame / 2);
      for (let i = 0; i < frame.length; i++) {
        frame[i] = data.readInt16LE(offset + i * 2);
      }
      frames.push(frame);
      offset += this.#bytesPerFrame;
    }
    // Copy rather than slice: `subarray` keeps the whole incoming chunk alive,
    // and an odd trailing byte would otherwise pin a buffer per callback.
    this.#carry = Buffer.from(data.subarray(offset));
    return frames;
  }
}
