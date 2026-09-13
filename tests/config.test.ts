import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

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
  assert.equal(c.director.fillerAfterMs, 1200);
  assert.equal(c.director.approvalTimeoutMs, 10000);
});

test('the API key is never exposed by stringifying config', () => {
  const c = loadConfig({ CARTESIA_API_KEY: 'sk_car_supersecret' });
  assert.ok(
    !JSON.stringify(c).includes('supersecret'),
    'config must not serialise the key — it ends up in logs and crash dumps',
  );
});
