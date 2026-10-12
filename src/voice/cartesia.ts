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
 * The handshake is measured at 458–500 ms on the target machine (see the class
 * comment). 8 s is a wide multiple of that, not a guess: it is long enough to
 * absorb a slow network without ever being mistaken for normal variance, and
 * short enough that a hung handshake still fails inside the turn, instead of
 * waiting for the unrelated 45 s turn-timeout in director.ts to notice.
 */
const CONNECT_TIMEOUT_MS = 8000;

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
  readonly #connectTimeoutMs: number;
  #spare: WebSocket | undefined;

  constructor(
    config: Config,
    opts: { connect?: (url: string) => WebSocket; connectTimeoutMs?: number } = {},
  ) {
    this.#config = config;
    this.#connect = opts.connect ?? ((url) => new WebSocket(url));
    this.#connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
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

  async *synthesize(
    text: AsyncIterable<string>,
    signal: AbortSignal,
    languageOverride?: string,
  ): AsyncIterable<AudioFrame> {
    // Barge-in can land before the first sentence exists. Do not open a socket
    // for audio nobody will hear.
    if (signal.aborted) return;

    const { model, voiceId } = this.#config.voice;
    // Per-call override, not a stored field: this class holds no conversation
    // state of its own (see the Voice interface doc comment) — the caller
    // (Director) is the one tracking which language the conversation is
    // currently in, and passes it fresh on every call.
    const language = languageOverride ?? this.#config.voice.language;
    const { deviceRate } = this.#config.audio;
    const key = this.#config.cartesiaKey();

    /** Nothing off the wire is trusted verbatim: the URL carries the key. */
    const redact = (message: string): string =>
      message.split(key).join('***').replace(/api_key=[^&\s"'),]+/gi, 'api_key=***');
    const fail = (message: string): Error => new Error(`Cartesia: ${redact(message)}`);

    const socket = this.#takeSocket();
    const contextId = randomUUID();
    const queue: AudioFrame[] = [];
    let done = false;
    let failure: Error | undefined;
    let wake: (() => void) | undefined;
    // Handle to the connect-timeout timer, hoisted out of the `opened`
    // executor so the `finally` block below can always clear it. Left
    // pending, it would hold the event loop open for up to
    // `connectTimeoutMs` after the generator is abandoned mid-handshake.
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Set once `open` has actually fired (or the reused spare was already
    // open). A close/error before this point is far more likely to be the
    // server rejecting the connection than a mid-stream network blip, so the
    // credits/key hint is only worth attaching then.
    let handshakeComplete = socket.readyState === OPEN;

    const notify = () => {
      wake?.();
      wake = undefined;
    };
    // Resolves the instant `finish()` runs, independent of whatever `feeding`
    // is doing. `feeding` awaits `text.next()`, which is fed by the director's
    // turn machinery and can legitimately not resolve for a while (the next
    // sentence may not exist yet). Without this, a `finish()` triggered by the
    // connect-timeout (or any other terminal event) would still leave the
    // generator blocked on `await feeding` below, defeating the timeout.
    let resolveStopped: () => void;
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    const finish = (err?: Error) => {
      // A deliberate barge-in is not a failure. Closing an undici socket fires
      // `error` on the way down, and reporting that would turn every successful
      // interruption into a thrown error.
      if (!signal.aborted) failure ??= err;
      done = true;
      notify();
      resolveStopped();
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

    socket.addEventListener('open', () => {
      handshakeComplete = true;
    });

    // Cartesia rejects an unauthorized/out-of-credits connection by closing the
    // socket, not by sending a `type: 'error'` message, so the raw close code
    // and reason are the only diagnostic available for that case.
    const creditsHint = () =>
      handshakeComplete ? '' : ' (possibly out of credits or an invalid API key)';

    socket.addEventListener('close', (event) => {
      // Silence is indistinguishable from thinking (spec §9), so a stream that
      // drops before it is finished has to say so.
      if (!done && !signal.aborted) {
        const { code, reason } = event as CloseEvent;
        const detail = reason ? `code ${code}, reason: ${reason}` : `code ${code}`;
        finish(fail(`connection closed before the audio was finished (${detail})${creditsHint()}`));
      } else finish();
    });
    socket.addEventListener('error', (event) => {
      const detail = (event as ErrorEvent).message ? `: ${(event as ErrorEvent).message}` : '';
      finish(fail(`connection failed${detail}${creditsHint()}`));
    });

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
      if (socket.readyState === OPEN) {
        resolve();
        return;
      }
      // A handshake that never fires `open`, `close`, nor `error` used to hang
      // the whole turn until the unrelated 45s turn-timeout in director.ts
      // called abort() — by which point the turn was already abandoned. Treat
      // silence past this deadline as a hard failure instead.
      timer = setTimeout(() => {
        finish(fail(`no response from the server after ${this.#connectTimeoutMs}ms while opening the connection${creditsHint()}`));
        try {
          socket.close();
        } catch {
          /* already closed, or never got that far */
        }
        resolve();
      }, this.#connectTimeoutMs);
      // A pending connect-timeout timer must never by itself keep the process
      // alive: `.close()`/CLI exit should not wait up to connectTimeoutMs on a
      // generator nobody is draining any more.
      timer.unref();
      const settled = (fn: () => void) => {
        clearTimeout(timer);
        fn();
      };
      socket.addEventListener('open', () => settled(resolve), { once: true });
      socket.addEventListener('close', () => settled(resolve), { once: true });
      socket.addEventListener('error', () => settled(resolve), { once: true });
      signal.addEventListener('abort', () => settled(resolve), { once: true });
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
      // In the happy path `feeding` has already settled by the time we get
      // here: the server can only send its own `done` message (which is what
      // sets `done = true` and lets the loop above reach this line) after it
      // has received our closing `send('', false)`, and sending that is the
      // last thing `feeding` does. So the closing message is always flushed
      // before the socket closes below — `Promise.race` changes nothing there.
      // What it does change is every other way `done` becomes true (the
      // connect timeout, a server error, a close, an abort): those resolve
      // `stopped` immediately, without requiring `text.next()` to ever
      // resolve, which is what used to make the timeout above pointless.
      await Promise.race([feeding, stopped]);
      if (failure && !signal.aborted) throw failure;
    } finally {
      signal.removeEventListener('abort', onAbort);
      clearTimeout(timer);
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
