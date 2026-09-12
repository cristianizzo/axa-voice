import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { encodeCommand, EventParser, PcmParser } from '../../src/audio/protocol.ts';

const helper = new URL('../../native/aecio', import.meta.url).pathname;
// Needs a real audio device and a microphone grant, so it opts out rather than
// hanging or failing mysteriously where neither exists (CI, ssh, no hardware).
const hasDevice =
  process.platform === 'darwin' && existsSync(helper) && !process.env.AXA_NO_AUDIO_HW;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('the helper captures real audio and flushes fast', { skip: !hasDevice }, async (t) => {
  const proc = spawn(helper, ['--rate', '24000', '--mic-rate', '16000']);
  const events = new EventParser();
  const pcm = new PcmParser(320);
  const seen: string[] = [];
  let frames = 0;
  let nonZero = 0;
  let flushed: { heardMs: number; renderReactionMs: number } | undefined;
  // Stamped on arrival, not after the sleep below: the round trip is what is
  // being measured, and it has to fit inside the 50 ms barge-in budget (spec §6).
  let flushedAt = 0;

  proc.stdout.on('data', (c: Buffer) => {
    for (const frame of pcm.push(c)) {
      frames++;
      for (const s of frame) if (s !== 0) nonZero++;
    }
  });
  proc.stderr.on('data', (c: Buffer) => {
    for (const e of events.push(c)) {
      seen.push(e.type);
      if (e.type === 'flushed') {
        flushed = e;
        flushedAt = Date.now();
      }
      assert.notEqual(e.type, 'malformed', 'helper emitted an unparseable line');
    }
  });

  await sleep(1500);
  assert.ok(seen.includes('ready'), `helper never became ready; saw ${seen.join(',')}`);
  assert.ok(frames > 30, `expected a steady frame stream, got ${frames}`);
  assert.ok(nonZero > 0, 'all samples were zero — microphone permission is denied');

  // Queue a second of silence-as-audio, then flush and time the reaction.
  proc.stdin.write(encodeCommand('A', Buffer.alloc(24000 * 2)));
  await sleep(200);
  const flushSentAt = Date.now();
  proc.stdin.write(encodeCommand('F'));
  await sleep(400);

  const ack = flushed;
  assert.ok(ack, 'no flushed event arrived');
  assert.ok(
    flushedAt - flushSentAt < 100,
    `flush acknowledgement took ${flushedAt - flushSentAt}ms to reach Node`,
  );
  assert.ok(
    ack.renderReactionMs < 50,
    `render reacted in ${ack.renderReactionMs}ms; MaximumFramesPerSlice was probably raised (spec §6)`,
  );
  assert.ok(
    ack.heardMs < 200,
    `heardMs must exclude the audio still inside the hardware pipeline, got ${ack.heardMs}`,
  );

  t.diagnostic(
    `ack ${flushedAt - flushSentAt}ms, render reaction ${ack.renderReactionMs.toFixed(1)}ms, ` +
      `heard ${ack.heardMs.toFixed(1)}ms, ${((100 * nonZero) / (frames * 320)).toFixed(1)}% non-zero mic samples`,
  );

  proc.stdin.write(encodeCommand('Q'));
  await sleep(200);
  proc.kill();
});
