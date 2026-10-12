import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { preflight } from '../../src/stt/server.ts';
import { loadConfig } from '../../src/config.ts';

const base = loadConfig({ CARTESIA_API_KEY: 'sk_test' });
const withStt = (over: Partial<typeof base.stt>) =>
  ({ ...base, stt: { ...base.stt, ...over } }) as typeof base;

test('preflight names the missing model file', async () => {
  await assert.rejects(
    preflight(withStt({ modelPath: '/nope/ggml-small.bin' })),
    /ggml-small\.bin/,
  );
});

test('the missing-model error never hardcodes a stale default filename', async () => {
  // The actual default model (config.ts) is ggml-large-v3-turbo.bin, not
  // ggml-small.bin — the error must point at whatever `modelPath` really is
  // instead of telling users to download a file the defaults no longer use.
  await assert.rejects(
    preflight(withStt({ modelPath: '/nope/ggml-large-v3-turbo.bin' })),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /ggml-large-v3-turbo\.bin/);
      assert.doesNotMatch(err.message, /ggml-small\.bin/);
      return true;
    },
  );
});

test('preflight refuses to start without the VAD model', async () => {
  await assert.rejects(
    preflight(withStt({ vadModelPath: '/nope/ggml-silero-v5.1.2.bin' })),
    /silero/i,
    'running without VAD means inventing user turns from silence (spec §8)',
  );
});

test('preflight rejects an already-occupied port', async () => {
  const squatter = createServer(() => {});
  await new Promise<void>((r) => squatter.listen(18178, '127.0.0.1', r));
  try {
    await assert.rejects(preflight(withStt({ port: 18178 })), /18178/);
  } finally {
    await new Promise<void>((r) => squatter.close(() => r()));
  }
});
