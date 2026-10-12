import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WhisperTranscriber, encodeWav } from '../../src/stt/transcriber.ts';
import { loadConfig } from '../../src/config.ts';

const config = loadConfig({ CARTESIA_API_KEY: 'sk_test' });
// 2000 sits comfortably above the RMS silence gate in transcriber.ts (600) so
// that these tests exercise the fetch path exactly as they did before that
// gate existed; the gate itself is covered by the dedicated tests below.
const frame = (fill = 2000) => Int16Array.from({ length: 320 }, () => fill);
// >= MIN_AUDIO_MS_FOR_LANGUAGE_DETECT (transcriber.ts): only a final built from
// this many pushed frames (320 samples each @ config.audio.frameRate=16000, so
// 110 * 320 / 16000 = 2.2s) is long enough for #final() to bother asking
// whisper-server to auto-detect at all — anything shorter now requests the
// current language explicitly instead of 'auto' (bug fix, 2026-09-27), so any
// test exercising the auto-detect/verbose_json path needs at least this many.
const LONG_UTTERANCE_FRAMES = 110;

/**
 * Only the FINAL transcription request now asks for `response_format:
 * 'verbose_json'` + `language: 'auto'` (see transcriber.ts's `#transcribe`
 * and `parseVerboseJson`'s doc comment for the empirically-verified shape).
 * A plain-text `new Response('ciao')` — which every one of these tests used
 * before that existed, and which is still exactly right for the PARTIAL
 * path's cheap `response_format: 'text'` — parses to an empty transcript on
 * the final path (parseVerboseJson's JSON.parse fails, so it falls back to
 * `{ text: '', ... }`), so any test asserting on `onFinal`'s text needs a
 * final-shaped body instead.
 */
const verboseJson = (text: string, language = 'it', confidence = 0.95) =>
  new Response(JSON.stringify({ text, language_probabilities: { [language]: confidence } }));

test('encodeWav writes a RIFF header whisper-server will accept', () => {
  const wav = encodeWav(new Int16Array(160), 16000);
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1, 'mono');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(34), 16, 'PCM16');
  assert.equal(wav.length, 44 + 320, 'header plus payload — raw PCM is rejected');
});

test('partials use audio_ctx=1000 and the final uses 0', async () => {
  const seen: string[] = [];
  const fetchFn = async (_url: string, init?: RequestInit) => {
    const form = init!.body as FormData;
    seen.push(String(form.get('audio_ctx')));
    return new Response('ciao');
  };
  const t = new WhisperTranscriber(config, { fetchFn: fetchFn as never });
  const stream = await t.open();
  for (let i = 0; i < 60; i++) stream.push(frame());
  await new Promise((r) => setTimeout(r, 450));
  await stream.close();

  assert.ok(seen.includes('1000'), 'partials must shrink the encoder context');
  assert.equal(seen.at(-1), '0', 'the final transcription must use full context');
});

test('a slow partial never overlaps the next tick', async () => {
  let inFlight = 0;
  let maxConcurrent = 0;
  const fetchFn = async () => {
    maxConcurrent = Math.max(maxConcurrent, ++inFlight);
    await new Promise((r) => setTimeout(r, 600));
    inFlight--;
    return new Response('ciao');
  };
  const t = new WhisperTranscriber(config, { fetchFn: fetchFn as never });
  const stream = await t.open();
  for (let i = 0; i < 200; i++) stream.push(frame());
  await new Promise((r) => setTimeout(r, 1400));
  await stream.close();

  assert.equal(maxConcurrent, 1, 'whisper-server serializes; overlapping stacks latency');
});

test('hallucinated partials are filtered before reaching subscribers', async () => {
  const fetchFn = async () => new Response(' [Musica]\n');
  const t = new WhisperTranscriber(config, { fetchFn: fetchFn as never });
  const stream = await t.open();
  const partials: string[] = [];
  stream.onPartial((text) => partials.push(text));
  for (let i = 0; i < 60; i++) stream.push(frame());
  await new Promise((r) => setTimeout(r, 450));
  await stream.close();

  assert.deepEqual(partials, [], '[Musica] must never become a user turn');
});

test('a failed partial does not kill the stream', async () => {
  let calls = 0;
  const fetchFn = async (_url: string, init?: RequestInit) => {
    if (++calls === 1) throw new Error('connection reset');
    const form = init!.body as FormData;
    if (form.get('response_format') === 'verbose_json') return verboseJson('ciao');
    return new Response('ciao');
  };
  const t = new WhisperTranscriber(config, { fetchFn: fetchFn as never });
  const stream = await t.open();
  const finals: string[] = [];
  stream.onFinal((text) => finals.push(text));
  for (let i = 0; i < 60; i++) stream.push(frame());
  await new Promise((r) => setTimeout(r, 450));
  await stream.close();

  assert.deepEqual(finals, ['ciao'], 'one dropped partial must not lose the turn');
});

test('a fast connection error is retried, not lost', async () => {
  // Regression coverage for #final()'s retry rule (2026-09-26 redesign): a
  // thrown connection error proves the server did no real work on that
  // attempt, so it is exactly the kind of failure #final() must retry with
  // whatever budget remains — see the sibling test below for the OTHER fast,
  // retryable failure (a non-ok HTTP response), and the two after that for
  // why a failure from our OWN timeout must NOT be retried the same way.
  let finals = 0;
  const fetchFn = async (_url: string, init?: RequestInit) => {
    const form = init!.body as FormData;
    if (form.get('audio_ctx') === '0') {
      finals += 1;
      if (finals === 1) throw new Error('connection reset');
      return verboseJson('ciao');
    }
    return new Response('ciao');
  };
  const t = new WhisperTranscriber(config, { fetchFn: fetchFn as never });
  const stream = await t.open();
  const heard: string[] = [];
  stream.onFinal((text) => heard.push(text));
  for (let i = 0; i < LONG_UTTERANCE_FRAMES; i++) stream.push(frame());
  await new Promise((r) => setTimeout(r, 450));
  await stream.close();

  assert.equal(finals, 2, 'the fast failure must be retried, not treated as final');
  assert.deepEqual(heard, ['ciao'], 'the final transcript must survive a transient connection error');
});

test('a non-ok HTTP response throws and is retried, not silently swallowed as \'\'', async () => {
  // Regression test for the reviewer's more-important finding (2026-09-26):
  // #transcribe() used to `return ''` on a non-ok response (e.g. a 503 when
  // whisper-server is overloaded) WITHOUT throwing, so #final()'s catch-and-
  // retry logic never saw it as a failure at all — it returned '' immediately,
  // with zero retries and zero logging. That silent-empty-forever shape
  // matches the live bug report more precisely than any timeout race. The fix
  // makes a non-ok response throw, so it is caught here and, being a fast
  // failure with no real work done, retried with the remaining budget.
  let finals = 0;
  const fetchFn = async (_url: string, init?: RequestInit) => {
    const form = init!.body as FormData;
    if (form.get('audio_ctx') === '0') {
      finals += 1;
      if (finals === 1) return new Response('overloaded', { status: 503 });
      return verboseJson('ciao');
    }
    return new Response('ciao');
  };
  const t = new WhisperTranscriber(config, { fetchFn: fetchFn as never });
  const stream = await t.open();
  const heard: string[] = [];
  stream.onFinal((text) => heard.push(text));
  for (let i = 0; i < LONG_UTTERANCE_FRAMES; i++) stream.push(frame());
  await new Promise((r) => setTimeout(r, 450));
  await stream.close();

  assert.equal(finals, 2, 'a 503 must be retried, not accepted as a silent empty transcript');
  assert.deepEqual(heard, ['ciao'], 'the final transcript must survive a transient 503');
});

test('a uniformly slow-but-alive response lands on the single generous timeout without any retry', async () => {
  // The exact live symptom the bug report is about: whisper-server runs
  // large-v3-turbo with -bs 5 -bo 5 beam search, and a live benchmark measured
  // it responding in well under 1.5s even under synthetic concurrent load —
  // but this test uses a synthetic 12s delay to exercise the "slow but real"
  // path with margin, comfortably under REQUEST_TIMEOUT_MS (15s), so this
  // must land on the ONE attempt #final() now makes, with no retry at all —
  // proving the fix does not merely "eventually" recover a slow response by
  // doubling the wait (the four earlier, rejected fix attempts' shared
  // defect), but delivers it promptly on the single real attempt.
  let finalAttempts = 0;
  const fetchFn = async (_url: string, init?: RequestInit) => {
    const form = init!.body as FormData;
    if (form.get('audio_ctx') !== '0') return new Response('ciao');
    finalAttempts += 1;
    return await new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(verboseJson('ciao')), 12_000);
      init!.signal!.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('timeout', 'TimeoutError'));
      });
    });
  };
  const t = new WhisperTranscriber(config, { fetchFn: fetchFn as never });
  const stream = await t.open();
  const heard: string[] = [];
  stream.onFinal((text) => heard.push(text));
  for (let i = 0; i < LONG_UTTERANCE_FRAMES; i++) stream.push(frame());
  await new Promise((r) => setTimeout(r, 450));
  const keepAlive = setInterval(() => {}, 100);
  const start = Date.now();
  try {
    await stream.close();
  } finally {
    clearInterval(keepAlive);
  }
  const elapsedMs = Date.now() - start;

  assert.equal(finalAttempts, 1, 'a 12s real response must land on the single attempt; no retry needed or wanted');
  assert.deepEqual(heard, ['ciao'], 'the final transcript must survive a uniformly slow-but-alive server');
  assert.ok(
    elapsedMs < 20_000,
    `a 12s response must not be doubled by a retry-induced queuing delay (took ${elapsedMs}ms)`,
  );
});

test('a genuinely hung connection times out once and gives up, without retrying into more queued time', async () => {
  // The core of the 2026-09-26 redesign: a reviewer proved that retrying
  // after OUR OWN AbortSignal timeout fires is unsafe, because whisper-server
  // serializes requests and aborting a fetch client-side does not stop the
  // matching decode server-side — a retry here would queue its real request
  // BEHIND that still-running (or truly stuck) decode, silently doubling the
  // wait. So a failure whose `error.name === 'TimeoutError'` (what
  // `AbortSignal.timeout()` sets as the abort reason) must end #final()
  // immediately, not trigger a retry — even though budget may remain.
  let finalAttempts = 0;
  const fetchFn = async (_url: string, init?: RequestInit) => {
    const form = init!.body as FormData;
    if (form.get('audio_ctx') !== '0') return new Response('ciao');
    finalAttempts += 1;
    // Never resolves on its own — the only way this settles is the fetch's
    // own AbortSignal firing, exactly like a genuinely dead/hung connection.
    return await new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => {
        reject(new DOMException('timeout', 'TimeoutError'));
      });
    });
  };
  const t = new WhisperTranscriber(config, { fetchFn: fetchFn as never });
  const stream = await t.open();
  const heard: string[] = [];
  stream.onFinal((text) => heard.push(text));
  for (let i = 0; i < 60; i++) stream.push(frame());
  await new Promise((r) => setTimeout(r, 450));
  // AbortSignal.timeout's internal timer is deliberately unref'd (Node does not
  // let a fetch deadline alone keep a process alive) — fine in the real app,
  // which always has other live handles, but in this test nothing else is
  // pending, so without a ref'd keep-alive Node would exit before the abort
  // this test is waiting on ever fires.
  const keepAlive = setInterval(() => {}, 100);
  const start = Date.now();
  try {
    await stream.close();
  } finally {
    clearInterval(keepAlive);
  }
  const elapsedMs = Date.now() - start;

  assert.equal(finalAttempts, 1, 'a timeout on our own attempt must not be retried into a second, queued request');
  assert.deepEqual(heard, [], 'a connection that never answers must resolve to no final, not throw or hang close()');
  assert.ok(
    elapsedMs < 20_000,
    `#final() must give up at the single REQUEST_TIMEOUT_MS deadline, not double it (took ${elapsedMs}ms)`,
  );
});

test('near-silent audio is gated before it ever reaches whisper-server', async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return new Response('Grazie a tutti');
  };
  const t = new WhisperTranscriber(config, { fetchFn: fetchFn as never });
  const stream = await t.open();
  const finals: string[] = [];
  stream.onFinal((text) => finals.push(text));
  for (let i = 0; i < 60; i++) stream.push(frame(1));
  await new Promise((r) => setTimeout(r, 450));
  await stream.close();

  assert.equal(calls, 0, 'room tone must never be sent to whisper-server');
  assert.deepEqual(finals, [], 'a gated final must not surface an empty/hallucinated turn');
});

test('normal-amplitude audio still reaches whisper-server', async () => {
  let calls = 0;
  const fetchFn = async (_url: string, init?: RequestInit) => {
    calls += 1;
    const form = init!.body as FormData;
    if (form.get('response_format') === 'verbose_json') return verboseJson('ciao');
    return new Response('ciao');
  };
  const t = new WhisperTranscriber(config, { fetchFn: fetchFn as never });
  const stream = await t.open();
  const finals: string[] = [];
  stream.onFinal((text) => finals.push(text));
  for (let i = 0; i < 60; i++) stream.push(frame());
  await new Promise((r) => setTimeout(r, 450));
  await stream.close();

  assert.ok(calls > 0, 'real-amplitude audio must not be silenced by the RMS gate');
  assert.deepEqual(finals, ['ciao']);
});

test('the final request asks whisper-server to auto-detect and surfaces its language + confidence', async () => {
  // Only the FINAL transcription may cost the extra round trip of asking
  // whisper-server to guess the language (spec: 2026-09-27 mid-conversation
  // language switch) — partials must stay on the cheap, fixed-language path
  // since they run every partialCadenceMs and are latency-sensitive.
  const forms: FormData[] = [];
  const fetchFn = async (_url: string, init?: RequestInit) => {
    const form = init!.body as FormData;
    forms.push(form);
    if (form.get('audio_ctx') === '0') return verboseJson('how are you', 'en', 0.87);
    return new Response('ciao');
  };
  const t = new WhisperTranscriber(config, { fetchFn: fetchFn as never });
  const stream = await t.open();
  const finals: Array<{ text: string; language: string; confidence: number | undefined }> = [];
  stream.onFinal((text, language, confidence) => finals.push({ text, language, confidence }));
  for (let i = 0; i < LONG_UTTERANCE_FRAMES; i++) stream.push(frame());
  await new Promise((r) => setTimeout(r, 450));
  await stream.close();

  assert.deepEqual(finals, [{ text: 'how are you', language: 'en', confidence: 0.87 }]);

  const finalForm = forms.at(-1)!;
  assert.equal(finalForm.get('language'), 'auto', 'the final must ask whisper-server to auto-detect');
  assert.equal(finalForm.get('response_format'), 'verbose_json', 'only verbose_json exposes a language guess');

  const partialForm = forms[0]!;
  assert.equal(partialForm.get('language'), config.stt.language, 'partials must stay on the fixed, configured language');
  assert.equal(partialForm.get('response_format'), 'text', 'partials must stay on the cheap text format');
});

test('a final response with no language_probabilities but an ISO-shaped fallback code is trusted', async () => {
  // Not every whisper-server build is guaranteed to expose per-language
  // probabilities (see parseVerboseJson's doc comment) — this must degrade to
  // "language known, confidence unknown" rather than losing the transcript,
  // as long as the fallback value already looks like an ISO 639-1 code.
  const fetchFn = async (_url: string, init?: RequestInit) => {
    const form = init!.body as FormData;
    if (form.get('audio_ctx') === '0') {
      return new Response(JSON.stringify({ text: 'hello there', detected_language: 'en' }));
    }
    return new Response('ciao');
  };
  const t = new WhisperTranscriber(config, { fetchFn: fetchFn as never });
  const stream = await t.open();
  const finals: Array<{ text: string; language: string; confidence: number | undefined }> = [];
  stream.onFinal((text, language, confidence) => finals.push({ text, language, confidence }));
  for (let i = 0; i < LONG_UTTERANCE_FRAMES; i++) stream.push(frame());
  await new Promise((r) => setTimeout(r, 450));
  await stream.close();

  assert.deepEqual(finals, [{ text: 'hello there', language: 'en', confidence: undefined }]);
});

test('a full-language-name fallback (not an ISO code) is treated as no detection at all', async () => {
  // Bug fix, 2026-09-27: whisper-server's `detected_language`/`language`
  // fields can be a full English name ('english', 'italian', ...), not an
  // ISO 639-1 code. Accepting it as-is used to set director.ts's `#language`
  // to a value that never equals 'it'/'en' (so it always looked like a
  // "switch") and would be sent to Cartesia as an invalid language code, with
  // `confidence: undefined` skipping the confidence gate entirely. Only a
  // real two-letter code shape is trusted; anything else degrades to '' —
  // the same as no detection.
  const fetchFn = async (_url: string, init?: RequestInit) => {
    const form = init!.body as FormData;
    if (form.get('audio_ctx') === '0') {
      return new Response(JSON.stringify({ text: 'hello there', detected_language: 'english' }));
    }
    return new Response('ciao');
  };
  const t = new WhisperTranscriber(config, { fetchFn: fetchFn as never });
  const stream = await t.open();
  const finals: Array<{ text: string; language: string; confidence: number | undefined }> = [];
  stream.onFinal((text, language, confidence) => finals.push({ text, language, confidence }));
  for (let i = 0; i < LONG_UTTERANCE_FRAMES; i++) stream.push(frame());
  await new Promise((r) => setTimeout(r, 450));
  await stream.close();

  assert.deepEqual(finals, [{ text: 'hello there', language: '', confidence: undefined }]);
});

test('a malformed final body yields an empty result rather than throwing', async () => {
  const fetchFn = async (_url: string, init?: RequestInit) => {
    const form = init!.body as FormData;
    if (form.get('audio_ctx') === '0') return new Response('not json at all');
    return new Response('ciao');
  };
  const t = new WhisperTranscriber(config, { fetchFn: fetchFn as never });
  const stream = await t.open();
  const finals: Array<{ text: string; language: string; confidence: number | undefined }> = [];
  stream.onFinal((text, language, confidence) => finals.push({ text, language, confidence }));
  for (let i = 0; i < LONG_UTTERANCE_FRAMES; i++) stream.push(frame());
  await new Promise((r) => setTimeout(r, 450));
  await stream.close();

  assert.deepEqual(finals, [], 'an unparsable body must not surface a final at all, not throw or hang');
});

test('a short final under MIN_AUDIO_MS_FOR_LANGUAGE_DETECT requests the current language explicitly, not auto', async () => {
  // Bug fix, 2026-09-27: requesting 'auto' unconditionally on every final,
  // even a one-word approval reply, meant the transcript itself was decoded
  // under a language guess with no real signal to go on (e.g. "sì" misheard
  // as English decoding to "see"). Below the duration threshold, the final
  // must ask for the current sticky language explicitly instead.
  const forms: FormData[] = [];
  const fetchFn = async (_url: string, init?: RequestInit) => {
    const form = init!.body as FormData;
    forms.push(form);
    return new Response('si');
  };
  const t = new WhisperTranscriber(config, { fetchFn: fetchFn as never });
  const stream = await t.open();
  const finals: Array<{ text: string; language: string; confidence: number | undefined }> = [];
  stream.onFinal((text, language, confidence) => finals.push({ text, language, confidence }));
  // Well under 2s: a single short utterance, not a whole sentence.
  for (let i = 0; i < 10; i++) stream.push(frame());
  await new Promise((r) => setTimeout(r, 450));
  await stream.close('en'); // the conversation's current sticky language

  const finalForm = forms.at(-1)!;
  assert.equal(finalForm.get('language'), 'en', 'a short final must ask for the current language, not auto');
  assert.equal(finalForm.get('response_format'), 'text', 'a short final does not need verbose_json');
  assert.deepEqual(finals, [{ text: 'si', language: '', confidence: undefined }]);
});
