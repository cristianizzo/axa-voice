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
 * Cap on a server that stops answering. Exists because the Director awaits
 * close() before it can reply and shutdown awaits it too: an unbounded wait here
 * is not a slow transcript, it is a session that never speaks again.
 *
 * This is BOTH the single timeout given to #final()'s one real attempt AND
 * its total retry budget — the two used to be different numbers (a short
 * "probe" cap on attempt one, a larger total for the retry after it), and
 * that shape is exactly what four separate attempts at this constant all got
 * wrong (2026-09-26):
 *   1. Flat 3s for every attempt (Math.min): any real response slower than
 *      3s became a guaranteed failure, no matter how much budget remained.
 *   2. 5s probe / 10s total: a response landing slow-but-real on the FIRST
 *      attempt (the normal case under load, not an edge case) still got
 *      aborted, and the retry only had ~4.75s left — LESS than the cap that
 *      had just failed, so it lost too.
 *   3. 12s probe / 25s total: same bug, later — the post-cap remainder
 *      (~12.75s) was only ~6% bigger than the cap itself.
 *   4. 8s probe / 28s total: widened the remainder to ~2.5x the cap, which
 *      looked generous on paper, but a reviewer proved the whole "abort our
 *      own probe, then retry" shape is broken regardless of the numbers:
 *      whisper-server SERIALIZES requests, and aborting a fetch client-side
 *      via AbortSignal does NOT stop the matching decode server-side. So the
 *      probe's abort at 8s does not free up the server — the retry's real
 *      request queues BEHIND the still-running decode from attempt one. A
 *      uniformly slow (not dead) server then needs roughly DOUBLE its real
 *      per-request latency to land a transcript, because the retry pays for
 *      both the original decode it queues behind and its own. No number of
 *      "probe cap" vs "total budget" fixes that; it is a defect in retrying
 *      after our own timeout at all, not in the timeout's size.
 *
 * The fix is a single generous attempt: one timeout, no probe-then-retry.
 * 15s (2026-09-26) is a generous safety margin above live large-v3-turbo
 * (-bs 5 -bo 5 beam search) latency, which a live benchmark measured at
 * well under 1.5s even under synthetic concurrent load — enough headroom for
 * "sometimes slower" without inviting a false-positive abort of a healthy,
 * still-in-flight response — while staying a small fraction (~33%) of the
 * 45_000ms turn watchdog (config.director.turnTimeoutMs): close() (which
 * awaits #final()) runs BEFORE #armTurnTimer() starts that watchdog
 * (src/director/director.ts #takeFinal()/#onTurnEnd()), so this budget adds
 * directly to user-perceived dead air rather than being covered by it, and
 * must not eat a large share of the turn's total time allowance on its own.
 *
 * #final() DOES still retry — see its doc comment — but only on a failure
 * that proves itself fast (the server never did any work on that attempt),
 * never on this timeout firing. A retry after our own timeout is exactly the
 * "queue behind the still-running decode" defect above, so this budget is a
 * ceiling on the one real attempt, not a total spread across several.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Single-attempt timeout for a partial (#tick()). Deliberately its own
 * constant, separate from REQUEST_TIMEOUT_MS: that constant used to double as
 * both the single request timeout AND the total retry budget, so a partial
 * calling #transcribe() with no explicit timeout silently inherited whatever
 * REQUEST_TIMEOUT_MS happened to mean at the time. Now that REQUEST_TIMEOUT_MS
 * is #final()'s one-real-attempt cap (see its doc comment), letting a partial
 * fall through to that same default would give a single partial request up to
 * REQUEST_TIMEOUT_MS to hang before #busy clears — and #busy gates every tick
 * and close(), so a hung partial would freeze the partial loop for that whole
 * span. 10s keeps a stuck partial from stalling the loop anywhere near that
 * long; a dropped partial costs nothing anyway (#tick()'s next pass resends
 * the same buffered audio).
 */
const PARTIAL_TIMEOUT_MS = 10_000;
const CLOSE_WAIT_MS = 2_000;

/**
 * How much buffered audio a final needs before it is even worth ASKING
 * whisper-server to auto-detect its language (bug fix, 2026-09-27).
 *
 * director.ts's MIN_WORDS_FOR_LANGUAGE_SWITCH/MIN_LANGUAGE_CONFIDENCE only
 * gate whether the Director ACTS on a detected language afterward — they do
 * nothing to protect the transcript itself, which whisper-server decodes
 * under whatever language the request asked for. Requesting `'auto'`
 * unconditionally on every final (including a single word like "sì") meant
 * even a one-word approval reply was decoded under a language guess that had
 * no real signal to go on, and a misdetected guess corrupts the WORDS
 * whisper-server returns, not just a downstream decision about them (e.g.
 * "sì" misheard as English decoding to "see" instead of "sì"). Below this
 * duration, the final is requested in the conversation's current sticky
 * language instead of `'auto'` — see `#final`/`#transcribe`. ~2s is short
 * utterances' upper bound in practice (a real word or two of speech), well
 * under what auto-detect needs to have any real signal.
 */
const MIN_AUDIO_MS_FOR_LANGUAGE_DETECT = 2_000;

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

/** What a transcription request settles to, final or partial alike. */
interface TranscribeResult {
  text: string;
  /** ISO 639-1 (e.g. 'it', 'en'), or '' when not requested/not determined. */
  language: string;
  /** whisper-server's own probability for `language`, when it exposes one. */
  confidence: number | undefined;
}

/**
 * Parses whisper-server's `response_format=verbose_json` body (used only for
 * the final transcription's `language: 'auto'` request — see `#transcribe`).
 *
 * Empirically verified against the installed binary (whisper.cpp 1.9.2,
 * `whisper-server`, 2026-09-27 — no vendored source or docs were available
 * locally, so this was checked by actually running the server against real
 * debug-audio fixtures rather than assumed from the OpenAI-compatible API
 * convention): a verbose_json response looks like
 *   { text, language: "english", detected_language: "english",
 *     detected_language_probability: 0.815,
 *     language_probabilities: { en: 0.815, it: 0.003, ... } }
 * `language`/`detected_language` are full English names, not ISO codes, and
 * duplicate each other — not usable directly against `config.stt.language`
 * ('it', 'en', ...). `language_probabilities`, however, is already keyed by
 * ISO 639-1 code, so the highest-probability entry is used as BOTH the
 * detected code and its confidence, sidestepping a full-name-to-code mapping
 * table entirely. If a different whisper-server build omits
 * `language_probabilities` (this shape is not documented anywhere the agent
 * building this could find, only observed), this falls back to
 * `detected_language`/`language` — but those are full English names
 * ("english", "italian"), not ISO 639-1 codes, so they are only accepted when
 * they happen to already look like a code (`/^[a-z]{2}$/`); otherwise this
 * returns `''`, the same as no detection at all. A full-name fallback used to
 * be accepted as-is, which could set director.ts's `#language` to a value
 * like `'english'` (never `=== 'it'`/`'en'`, so it always looked like a
 * "switch"), sent straight to Cartesia as an invalid language code — and with
 * `confidence: undefined` on that path, it skipped the confidence gate
 * entirely, not merely the word-count one. The caller (director.ts) is built
 * to treat `confidence: undefined`/an empty language as "no signal" and gate
 * on word count alone, so returning '' here is a safe, deliberate no-op.
 */
function parseVerboseJson(raw: string, debug?: (message: string) => void): TranscribeResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    debug?.(
      `final: verbose_json response body was unparsable, treating as no detection: ` +
        `error=${error instanceof Error ? error.message : String(error)} body=${raw.slice(0, 200)}`,
    );
    return { text: '', language: '', confidence: undefined };
  }
  const obj = json as Record<string, unknown>;
  const text = clean(typeof obj.text === 'string' ? obj.text : '');

  const probs = obj.language_probabilities;
  if (probs && typeof probs === 'object') {
    let bestCode = '';
    let bestProb = -1;
    for (const [code, prob] of Object.entries(probs as Record<string, unknown>)) {
      if (typeof prob === 'number' && prob > bestProb) {
        bestProb = prob;
        bestCode = code;
      }
    }
    if (bestCode) return { text, language: bestCode, confidence: bestProb };
  }

  const fallbackRaw =
    typeof obj.detected_language === 'string'
      ? obj.detected_language
      : typeof obj.language === 'string'
        ? obj.language
        : '';
  // Only a real ISO 639-1 code shape is trusted; a full English name
  // ('english', 'italian', ...) is treated as no detection at all.
  const fallback = /^[a-z]{2}$/.test(fallbackRaw) ? fallbackRaw : '';
  return { text, language: fallback, confidence: undefined };
}

export class WhisperTranscriber implements Transcriber {
  readonly #config: Config;
  readonly #fetchFn: typeof fetch;
  readonly #dumpDir: string | undefined;

  readonly #debug: ((message: string) => void) | undefined;

  constructor(
    config: Config,
    opts: { fetchFn?: typeof fetch; dumpDir?: string; debug?: (message: string) => void } = {},
  ) {
    this.#config = config;
    this.#fetchFn = opts.fetchFn ?? fetch;
    this.#dumpDir = opts.dumpDir;
    this.#debug = opts.debug;
  }

  async open(): Promise<TranscriptionStream> {
    return new WhisperStream(this.#config, this.#fetchFn, this.#dumpDir, this.#debug);
  }
}

class WhisperStream implements TranscriptionStream {
  readonly #config: Config;
  readonly #fetchFn: typeof fetch;
  readonly #dumpDir: string | undefined;
  readonly #partialHandlers = new Set<(t: string) => void>();
  readonly #finalHandlers = new Set<(t: string, language: string, confidence: number | undefined) => void>();
  readonly #debugFn: ((message: string) => void) | undefined;
  #samples: number[] = [];
  #timer: NodeJS.Timeout;
  #busy = false;
  #closed = false;

  constructor(
    config: Config,
    fetchFn: typeof fetch,
    dumpDir: string | undefined,
    debugFn?: (message: string) => void,
  ) {
    this.#config = config;
    this.#fetchFn = fetchFn;
    this.#dumpDir = dumpDir;
    this.#debugFn = debugFn;
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

  onFinal(
    cb: (text: string, language: string, confidence: number | undefined) => void,
  ): Unsubscribe {
    this.#finalHandlers.add(cb);
    return () => this.#finalHandlers.delete(cb);
  }

  /** No-op unless a `debug` dep was injected — never a bare `console.log` here. */
  #debug(message: string): void {
    this.#debugFn?.(message);
  }

  /**
   * `currentLanguage` is the Director's own sticky conversation language
   * (director.ts's `#language`), passed in so `#final` knows what to request
   * explicitly when the buffered audio is too short to bother auto-detecting
   * (see MIN_AUDIO_MS_FOR_LANGUAGE_DETECT) — defaulting to
   * `config.stt.language` keeps every other caller (shutdown, tests) working
   * exactly as before this parameter existed.
   */
  async close(currentLanguage: string = this.#config.stt.language): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    // Wait out an in-flight partial: the server serializes, so racing it would
    // only make the final transcript slower (spec §5). Bounded, because a
    // partial that never comes back must not take the turn down with it.
    const until = Date.now() + CLOSE_WAIT_MS;
    while (this.#busy && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    const result = await this.#final(currentLanguage);
    if (result.text) {
      for (const handler of this.#finalHandlers) handler(result.text, result.language, result.confidence);
    }
  }

  /**
   * The final transcription is the one that must not be lost. A dropped partial
   * is recoverable — the next tick sends the same buffered audio — but the final
   * has no next tick. Retry until it lands or the budget is spent; after that,
   * `''` keeps close() from throwing, which would reject the Director's turn end
   * — logged first (below), since a silent `''` here is indistinguishable from
   * an ordinary "nothing was said" and was exactly how this bug went unnoticed.
   *
   * One real attempt, one generous timeout (REQUEST_TIMEOUT_MS) — NOT a short
   * "probe" cap followed by an uncapped retry. Four prior attempts at this
   * function all used that probe-then-retry shape with different numbers, and
   * a reviewer proved the shape itself is broken, not just the numbers: a
   * fetch aborted client-side via AbortSignal does not stop whisper-server's
   * matching decode, which keeps running server-side. Since the server
   * serializes requests, retrying after our own abort queues the retry's real
   * request BEHIND that still-running decode — a uniformly slow (not dead)
   * server then takes roughly double its real latency to land a transcript,
   * because the retry pays for both decodes. See REQUEST_TIMEOUT_MS's doc
   * comment for the exact history.
   *
   * So retrying here is only safe when the failure itself proves the server
   * did no real work on that attempt — a thrown connection error (fetch
   * couldn't even reach the server: ECONNREFUSED, connection reset, etc.) or a
   * non-ok HTTP response (whisper-server answered fast with a rejection, e.g.
   * a 503 when overloaded — see #transcribe()'s doc comment for why that now
   * throws instead of silently returning ''). Both are near-instant, so
   * retrying them costs the deadline almost nothing. A failure from OUR OWN
   * timeout firing (`error.name === 'TimeoutError'`, the reason
   * `AbortSignal.timeout()` sets — see the connection-error case above for
   * the contrast) proves nothing of the kind: the decode may still be
   * in-flight server-side, so retrying it is exactly the queuing defect this
   * redesign exists to remove. That case gives up immediately instead.
   *
   * `detectLanguage` is decided once here, from the buffered audio's own
   * duration — not unconditionally true — because auto-detect has no real
   * signal to work with on a one- or two-word utterance, and a wrong guess
   * there corrupts the transcript itself (whisper-server decodes UNDER
   * whatever language the request asked for), not just a downstream decision
   * about the guess. Below MIN_AUDIO_MS_FOR_LANGUAGE_DETECT, the request asks
   * for `currentLanguage` explicitly instead of `'auto'`. See
   * MIN_AUDIO_MS_FOR_LANGUAGE_DETECT's doc comment.
   */
  async #final(currentLanguage: string): Promise<TranscribeResult> {
    const empty: TranscribeResult = { text: '', language: '', confidence: undefined };
    const durationMs = (this.#samples.length / this.#config.audio.frameRate) * 1000;
    const detectLanguage = durationMs >= MIN_AUDIO_MS_FOR_LANGUAGE_DETECT;
    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    for (;;) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        this.#debug(`final: gave up after ${REQUEST_TIMEOUT_MS}ms budget with no transcript`);
        return empty;
      }
      try {
        return await this.#transcribe(0, remainingMs, detectLanguage, currentLanguage);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (error instanceof Error && error.name === 'TimeoutError') {
          // Our own timeout fired: the decode may still be running
          // server-side. Retrying would queue a fresh request behind it, not
          // recover a dead connection — see this method's doc comment.
          this.#debug(
            `final: gave up — own ${remainingMs}ms timeout fired with no transcript ` +
              `(not retrying: the server may still be working on it) error=${errorMessage}`,
          );
          return empty;
        }
        // A fast, provably-no-work failure (connection error or non-ok
        // response): safe to retry with whatever budget remains.
        if (Date.now() >= deadline) {
          this.#debug(
            `final: gave up after ${REQUEST_TIMEOUT_MS}ms budget with no transcript error=${errorMessage}`,
          );
          return empty;
        }
        this.#debug(`final: retrying after failure error=${errorMessage}`);
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  async #tick(): Promise<void> {
    if (this.#busy || this.#closed || !this.#samples.length) return;
    try {
      const { text } = await this.#transcribe(
        this.#config.stt.partialAudioCtx,
        PARTIAL_TIMEOUT_MS,
        false,
        this.#config.stt.language,
      );
      if (text && !this.#closed) {
        for (const handler of this.#partialHandlers) handler(text);
      }
    } catch (error) {
      // A dropped partial is recoverable: the next tick sends the same audio.
      this.#debug(`tick: partial failed, dropping: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * `detectLanguage` is only ever true for the final (`#final()`'s single
   * request per attempt) — see `parseVerboseJson`'s doc comment for the
   * response shape this asks whisper-server for, and why. A partial
   * (`#tick()`, every `partialCadenceMs`, latency-sensitive, and its result is
   * transient narration text, never the answer whisper-server actually feeds
   * the agent) deliberately stays on the original cheap `response_format:
   * 'text'` path with a fixed, non-'auto' language — forcing a per-request
   * language switch onto that path too was considered and rejected: a partial
   * is not what decides the conversation's language (see director.ts's
   * sticky-language policy, which only ever reads a *final*'s language), so
   * there is no correctness reason to pay verbose_json's larger response body
   * on a request this frequent.
   */
  async #transcribe(
    audioCtx: number,
    timeoutMs: number,
    detectLanguage: boolean,
    language: string,
  ): Promise<TranscribeResult> {
    const empty: TranscribeResult = { text: '', language: '', confidence: undefined };
    if (!this.#samples.length) return empty;
    // Below this, it's room tone/background noise, not speech: skip the
    // network round trip entirely rather than hand whisper-server something
    // it is prone to hallucinate a confident sign-off over (see
    // SILENCE_RMS_THRESHOLD above).
    if (rms(this.#samples) < SILENCE_RMS_THRESHOLD) return empty;
    this.#busy = true;
    try {
      const { port } = this.#config.stt;
      const wav = encodeWav(Int16Array.from(this.#samples), this.#config.audio.frameRate);

      const form = new FormData();
      form.set('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
      if (detectLanguage) {
        // 'auto' + verbose_json is what makes whisper-server report a
        // per-utterance detected language at all (see parseVerboseJson's doc
        // comment) — empirically confirmed against the installed
        // whisper-server binary that a per-request 'language' field overrides
        // the server's own `-l` startup default (server.ts), so this does not
        // need server.ts to spawn with `-l auto` itself; config.stt.language
        // stays the fixed default for the partial path below.
        form.set('response_format', 'verbose_json');
        form.set('language', 'auto');
      } else {
        // Either the partial path (always fixed, see this method's doc
        // comment) or a final too short to bother auto-detecting (see
        // MIN_AUDIO_MS_FOR_LANGUAGE_DETECT) — `language` is whichever the
        // caller decided: `config.stt.language` for a partial, the
        // Director's current sticky language for a short final, not always
        // the hardcoded config default.
        form.set('response_format', 'text');
        form.set('language', language);
      }
      form.set('audio_ctx', String(audioCtx));

      const res = await this.#fetchFn(`http://127.0.0.1:${port}/inference`, {
        method: 'POST',
        body: form,
        // Without a deadline a hung request leaves #busy set for ever, and every
        // later tick and close() then waits on a partial that will never land.
        // timeoutMs is always passed explicitly by both callers, deliberately —
        // no default here, because a default used to silently repurpose
        // REQUEST_TIMEOUT_MS as a partial's timeout too (see PARTIAL_TIMEOUT_MS's
        // doc comment). For a partial (#tick(), single attempt, no retry) it is
        // PARTIAL_TIMEOUT_MS. For a final (#final()'s retry loop) it is
        // whatever of REQUEST_TIMEOUT_MS remains of the total budget — see the
        // constant's doc comment and #final()'s doc comment for why there is
        // deliberately no separate, shorter "probe" timeout anymore.
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        // MUST throw, not return '': #final() retries on ANY throw (a fast,
        // provably-no-work failure — see its doc comment), but a bare `return
        // ''` here is indistinguishable from whisper genuinely hearing
        // nothing. A reviewer found this was the live bug's actual mechanism
        // — more so than the timeout race the first four fixes chased — a
        // 503 (server overloaded) landed here, returned '' with zero retries
        // and zero logging, and the turn went silent with no error anywhere.
        void this.#dump(audioCtx, wav, '');
        throw new Error(`whisper-server responded ${res.status} ${res.statusText}`);
      }
      if (detectLanguage) {
        const result = parseVerboseJson(await res.text(), (message) => this.#debug(message));
        void this.#dump(audioCtx, wav, result.text);
        return result;
      }
      const text = clean(await res.text());
      void this.#dump(audioCtx, wav, text);
      return { text, language: '', confidence: undefined };
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
