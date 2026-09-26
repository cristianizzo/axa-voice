import { randomUUID } from 'node:crypto';
import type { AudioFrame, Voice } from '../types.ts';
import type { Config } from '../config.ts';

interface CartesiaMessage {
  type?: string;
  data?: string;
  message?: string;
  title?: string;
}

const CONNECTING = 0;
const OPEN = 1;

/**
 * Cartesia over the WebSocket endpoint, never `/tts/bytes`.
 *
 * The socket accepts incremental `transcript` chunks under one `context_id`,
 * which is exactly the shape SpeechFilter emits, and it returns audio before
 * the text is finished. `/tts/bytes` cannot start until the whole sentence
 * exists. Measured median first audio: 150 ms (spec §4).
 *
 * That 150 ms is measured **from an open socket**. Measured on the target
 * machine, the handshake itself costs 458–500 ms and does not get cheaper on
 * the second or third connection, so opening one per turn would spend a third
 * of the whole 1300 ms budget before a single byte of text is sent. Hence
 * `prewarm()`: the connection is paid for while the user is still talking.
 */
export class CartesiaVoice implements Voice {
  readonly #config: Config;
  readonly #connect: (url: string) => WebSocket;
  #spare: WebSocket | undefined;

  constructor(config: Config, opts: { connect?: (url: string) => WebSocket } = {}) {
    this.#config = config;
    this.#connect = opts.connect ?? ((url) => new WebSocket(url));
  }

  /**
   * Open the connection the next turn will use. Call it off the critical path —
   * at startup, and it is renewed automatically after each turn that uses it.
   */
  prewarm(): void {
    if (this.#spare) return;
    const socket = this.#connect(this.#url());
    this.#spare = socket;
    const drop = () => {
      if (this.#spare === socket) this.#spare = undefined;
    };
    // Also stops an idle socket dying into an unhandled error event.
    socket.addEventListener('close', drop, { once: true });
    socket.addEventListener('error', drop, { once: true });
  }

  /** Release the spare connection. Nothing else holds state. */
  close(): void {
    const spare = this.#spare;
    this.#spare = undefined;
    try {
      spare?.close();
    } catch {
      /* already closed */
    }
  }

  #url(): string {
    return (
      `wss://api.cartesia.ai/tts/websocket` +
      `?cartesia_version=${encodeURIComponent(this.#config.voice.apiVersion)}` +
      `&api_key=${encodeURIComponent(this.#config.cartesiaKey())}`
    );
  }

  /** The spare if it is still usable, otherwise a fresh connection. */
  #takeSocket(): WebSocket {
    const spare = this.#spare;
    // Cleared before the usability test, not after it: a spare that died in the
    // meantime has to leave the field too, or prewarm() below sees it, decides a
    // spare already exists, and every later turn pays the 458-500ms handshake.
    this.#spare = undefined;
    const usable = spare && (spare.readyState === OPEN || spare.readyState === CONNECTING);
    const socket = usable ? spare : this.#connect(this.#url());
    // Start the next handshake now, so it overlaps this turn's audio.
    this.prewarm();
    return socket;
  }

  async *synthesize(text: AsyncIterable<string>, signal: AbortSignal): AsyncIterable<AudioFrame> {
    // Barge-in can land before the first sentence exists. Do not open a socket
    // for audio nobody will hear.
    if (signal.aborted) return;

    const { model, voiceId, language } = this.#config.voice;
    const { deviceRate } = this.#config.audio;
    const key = this.#config.cartesiaKey();

    /** Nothing off the wire is trusted verbatim: the URL carries the key. */
    const redact = (message: string): string =>
      message.split(key).join('***').replace(/api_key=[^&\s"']+/gi, 'api_key=***');
    const fail = (message: string): Error => new Error(`Cartesia: ${redact(message)}`);

    const socket = this.#takeSocket();
    const contextId = randomUUID();
    const queue: AudioFrame[] = [];
    let done = false;
    let failure: Error | undefined;
    let wake: (() => void) | undefined;

    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const finish = (err?: Error) => {
      // A deliberate barge-in is not a failure. Closing an undici socket fires
      // `error` on the way down, and reporting that would turn every successful
      // interruption into a thrown error.
      if (!signal.aborted) failure ??= err;
      done = true;
      notify();
    };

    socket.addEventListener('message', (event) => {
      let message: CartesiaMessage;
      try {
        message = JSON.parse((event as MessageEvent).data as string) as CartesiaMessage;
      } catch {
        finish(fail('unreadable message from the server'));
        return;
      }
      if (message.type === 'chunk' && message.data) {
        const bytes = Buffer.from(message.data, 'base64');
        // Cartesia always sends whole samples; an odd trailing byte is dropped
        // rather than shifting every sample that follows it.
        const frame = new Int16Array(bytes.length >> 1);
        for (let i = 0; i < frame.length; i++) frame[i] = bytes.readInt16LE(i * 2);
        queue.push(frame);
        notify();
      } else if (message.type === 'done') {
        finish();
      } else if (message.type === 'error') {
        finish(fail(message.message ?? message.title ?? 'unknown error'));
      }
    });

    socket.addEventListener('close', () => {
      // Silence is indistinguishable from thinking (spec §9), so a stream that
      // drops before it is finished has to say so.
      if (!done && !signal.aborted) finish(fail('connection closed before the audio was finished'));
      else finish();
    });
    socket.addEventListener('error', () => finish(fail('connection failed')));

    const send = (transcript: string, more: boolean): void => {
      socket.send(
        JSON.stringify({
          model_id: model,
          context_id: contextId,
          transcript,
          voice: { mode: 'id', id: voiceId },
          language,
          // Matches config.audio.deviceRate, not an independent number: the
          // point (spec §3) is zero resampling between Cartesia's output and
          // what the speaker expects, which only holds if this is the same
          // value, not a second one a human has to keep in sync by hand.
          output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: deviceRate },
          continue: more,
        }),
      );
    };

    const onAbort = () => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      finish();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const opened = new Promise<void>((resolve) => {
      // A prewarmed socket has already fired `open`, and it never fires twice.
      if (socket.readyState === OPEN) resolve();
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('close', () => resolve(), { once: true });
      signal.addEventListener('abort', () => resolve(), { once: true });
    });

    // Feed each sentence the moment it exists, and close the context with an
    // empty final message. Holding sentence n back until n+1 arrives would add
    // exactly the latency this design exists to remove (spec §4).
    const feeding = (async () => {
      await opened;
      for await (const sentence of text) {
        if (signal.aborted || done) return;
        send(sentence, true);
      }
      if (!signal.aborted && !done) send('', false);
    })().catch((err: unknown) => {
      finish(fail(err instanceof Error ? err.message : 'failed to send the transcript'));
    });

    try {
      for (;;) {
        while (queue.length) {
          if (signal.aborted) return;
          yield queue.shift()!;
        }
        if (done) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      await feeding;
      if (failure && !signal.aborted) throw failure;
    } finally {
      signal.removeEventListener('abort', onAbort);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      // Never leave the feeder as an unhandled rejection when we return early.
      void feeding;
    }
  }
}
