import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';
import { REQUEST_TIMEOUT_MS } from '../src/stt/transcriber.ts';

test('loadConfig fails loudly when the TTS key is missing', () => {
  assert.throws(
    () => loadConfig({}),
    /CARTESIA_API_KEY/,
    'a missing key must fail at startup, never at first speech (spec §9)',
  );
});

test('loadConfig exposes the measured constants from spec §4', () => {
  const c = loadConfig({ CARTESIA_API_KEY: 'sk_test' });
  assert.equal(c.audio.deviceRate, 24000);
  assert.equal(c.audio.frameRate, 16000);
  assert.equal(c.audio.frameSamples, 320);
  assert.equal(c.turn.silenceMs, 250);
  assert.equal(c.turn.unfinishedSilenceMs, 700);
  assert.equal(c.stt.partialCadenceMs, 350);
  assert.equal(c.stt.partialAudioCtx, 1000);
  assert.equal(c.director.approvalTimeoutMs, 20000);
});

test('the approval timeout leaves real headroom over whisper\'s own worst case', () => {
  const c = loadConfig({ CARTESIA_API_KEY: 'sk_test' });
  // Not just `>` — the whole race this fix exists to close is
  // director.director.ts's approvalTimeoutMs outliving
  // stt/transcriber.ts's REQUEST_TIMEOUT_MS (whisper's single generous
  // attempt at a final transcription), plus room for the question being
  // spoken, the user's reaction, and the VAD's trailing-silence wait either
  // side of it. A future edit to either constant in isolation that erodes
  // that margin should fail this test, not silently reintroduce the race.
  const MARGIN_MS = 3000;
  assert.ok(
    c.director.approvalTimeoutMs > REQUEST_TIMEOUT_MS + MARGIN_MS,
    `approvalTimeoutMs (${c.director.approvalTimeoutMs}) must clear REQUEST_TIMEOUT_MS ` +
      `(${REQUEST_TIMEOUT_MS}) by at least ${MARGIN_MS}ms`,
  );
});

test('the API key is never exposed by stringifying config', () => {
  const c = loadConfig({ CARTESIA_API_KEY: 'sk_car_supersecret' });
  assert.ok(
    !JSON.stringify(c).includes('supersecret'),
    'config must not serialise the key — it ends up in logs and crash dumps',
  );
});
