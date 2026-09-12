import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WhisperTranscriber, encodeWav } from '../../src/stt/transcriber.ts';
import { loadConfig } from '../../src/config.ts';

const config = loadConfig({ CARTESIA_API_KEY: 'sk_test' });
const frame = (fill = 1) => Int16Array.from({ length: 320 }, () => fill);

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
  const fetchFn = async () => {
    if (++calls === 1) throw new Error('connection reset');
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
