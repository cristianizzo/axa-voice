import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { AudioDevice } from '../../src/audio/device.ts';
import { loadConfig } from '../../src/config.ts';

function fakeHelper() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill(): void;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = () => {};
  return proc;
}

const config = loadConfig({ CARTESIA_API_KEY: 'sk_test' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('start resolves only once the helper reports ready', async () => {
  const proc = fakeHelper();
  const device = new AudioDevice(config, { spawnFn: (() => proc) as never });
  let resolved = false;
  const started = device.start().then(() => {
    resolved = true;
  });

  await sleep(20);
  assert.equal(resolved, false, 'start must not resolve before the device is ready');

  proc.stderr.write('{"type":"ready","rate":24000,"micRate":16000}\n');
  await started;
  assert.equal(resolved, true);
});

test('onFrame delivers fixed-size frames from the raw byte stream', async () => {
  const proc = fakeHelper();
  const device = new AudioDevice(config, { spawnFn: (() => proc) as never });
  const started = device.start();
  proc.stderr.write('{"type":"ready","rate":24000,"micRate":16000}\n');
  await started;

  const frames: Int16Array[] = [];
  device.onFrame((f) => frames.push(f));
  proc.stdout.write(Buffer.alloc(320 * 2 * 3));
  await sleep(20);

  assert.equal(frames.length, 3);
  assert.equal(frames[0]!.length, 320);
});

test('flush resolves with heardMs from the helper, not from bytes queued', async () => {
  const proc = fakeHelper();
  const device = new AudioDevice(config, { spawnFn: (() => proc) as never });
  const started = device.start();
  proc.stderr.write('{"type":"ready","rate":24000,"micRate":16000}\n');
  await started;

  const pending = device.flush();
  await sleep(10);
  proc.stderr.write(
    '{"type":"flushed","seq":1,"heardMs":1412.7,"consumedMs":1440,"renderReactionMs":8.4}\n',
  );
  assert.deepEqual(await pending, { heardMs: 1412.7 });
});

test('concurrent flushes each resolve with their own sequence number', async () => {
  const proc = fakeHelper();
  const device = new AudioDevice(config, { spawnFn: (() => proc) as never });
  const started = device.start();
  proc.stderr.write('{"type":"ready","rate":24000,"micRate":16000}\n');
  await started;

  const first = device.flush();
  const second = device.flush();
  proc.stderr.write(
    '{"type":"flushed","seq":1,"heardMs":10,"consumedMs":10,"renderReactionMs":1}\n',
  );
  proc.stderr.write(
    '{"type":"flushed","seq":2,"heardMs":20,"consumedMs":20,"renderReactionMs":1}\n',
  );

  assert.deepEqual(await first, { heardMs: 10 });
  assert.deepEqual(await second, { heardMs: 20 });
});

test('a flush the helper coalesced still resolves instead of hanging', async () => {
  // The render callback collapses two flush requests that land inside one
  // callback into a single ack carrying the HIGHER sequence number, so an
  // implementation keyed strictly on equality leaves the first flush pending
  // forever — and the Director awaits flush() before it can hear the user.
  const proc = fakeHelper();
  const device = new AudioDevice(config, { spawnFn: (() => proc) as never });
  const started = device.start();
  proc.stderr.write('{"type":"ready","rate":24000,"micRate":16000}\n');
  await started;

  const first = device.flush();
  const second = device.flush();
  proc.stderr.write(
    '{"type":"flushed","seq":2,"heardMs":20,"consumedMs":20,"renderReactionMs":1}\n',
  );

  assert.deepEqual(await first, { heardMs: 20 });
  assert.deepEqual(await second, { heardMs: 20 });
});

test('helper errors surface to onError rather than being swallowed', async () => {
  const proc = fakeHelper();
  const device = new AudioDevice(config, { spawnFn: (() => proc) as never });
  const started = device.start();
  proc.stderr.write('{"type":"ready","rate":24000,"micRate":16000}\n');
  await started;

  const errors: string[] = [];
  device.onError((m) => errors.push(m));
  proc.stderr.write(
    '{"type":"error","message":"microphone delivered only digital silence for 2s"}\n',
  );
  await sleep(10);

  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /digital silence/);
});

test('a crashed helper rejects start rather than hanging forever', async () => {
  const proc = fakeHelper();
  const device = new AudioDevice(config, { spawnFn: (() => proc) as never });
  const started = device.start();
  proc.emit('exit', 1, null);
  await assert.rejects(started, /exited/);
});

test('isPlaying tracks queued audio and clears on flush', async () => {
  const proc = fakeHelper();
  const device = new AudioDevice(config, { spawnFn: (() => proc) as never });
  const started = device.start();
  proc.stderr.write('{"type":"ready","rate":24000,"micRate":16000}\n');
  await started;

  assert.equal(device.isPlaying(), false);
  device.enqueue(new Int16Array(320));
  assert.equal(device.isPlaying(), true);

  const pending = device.flush();
  proc.stderr.write(
    '{"type":"flushed","seq":1,"heardMs":0,"consumedMs":0,"renderReactionMs":1}\n',
  );
  await pending;
  assert.equal(device.isPlaying(), false);
});

test('enqueue writes a framed A command carrying the samples little-endian', async () => {
  const proc = fakeHelper();
  const device = new AudioDevice(config, { spawnFn: (() => proc) as never });
  const started = device.start();
  proc.stderr.write('{"type":"ready","rate":24000,"micRate":16000}\n');
  await started;

  const written: Buffer[] = [];
  proc.stdin.on('data', (c: Buffer) => written.push(c));
  device.enqueue(Int16Array.from([-12345, 12345]));
  await sleep(10);

  const out = Buffer.concat(written);
  assert.equal(String.fromCharCode(out[0]!), 'A');
  assert.equal(out.readUInt32LE(1), 4);
  assert.equal(out.readInt16LE(5), -12345);
  assert.equal(out.readInt16LE(7), 12345);
});

test('a playback overflow is reported instead of truncating the answer in silence', async () => {
  const proc = fakeHelper();
  const device = new AudioDevice(config, { spawnFn: (() => proc) as never });
  const started = device.start();
  proc.stderr.write('{"type":"ready","rate":24000,"micRate":16000}\n');
  await started;

  const errors: string[] = [];
  device.onError((m) => errors.push(m));
  proc.stderr.write('{"type":"overflow","dropped":480}\n');
  await sleep(10);

  assert.equal(errors.length, 1, 'dropped playback is the one failure with no other symptom');
  assert.match(errors[0]!, /truncated/);
});

test('a microphone delivering only digital silence is reported, not waited on', async () => {
  const proc = fakeHelper();
  const device = new AudioDevice(config, { spawnFn: (() => proc) as never });
  const started = device.start();
  proc.stderr.write('{"type":"ready","rate":24000,"micRate":16000}\n');
  await started;

  const errors: string[] = [];
  device.onError((m) => errors.push(m));

  // Six seconds of exactly-zero samples. A live microphone never produces them:
  // even a quiet room carries a noise floor.
  proc.stdout.write(Buffer.alloc(config.audio.frameRate * 2 * 6));
  await sleep(20);

  assert.equal(errors.length, 1, 'said once, not once per 20ms frame');
  assert.match(errors[0]!, /silence/);
});

test('a quiet moment during playback is not mistaken for a dead microphone', async () => {
  const proc = fakeHelper();
  const device = new AudioDevice(config, { spawnFn: (() => proc) as never });
  const started = device.start();
  proc.stderr.write('{"type":"ready","rate":24000,"micRate":16000}\n');
  await started;

  const errors: string[] = [];
  device.onError((m) => errors.push(m));

  // Echo cancellation is entitled to gate the microphone to nothing while the
  // agent is talking, which is most of the time it is worth listening at all.
  device.enqueue(new Int16Array(config.audio.deviceRate * 10));
  proc.stdout.write(Buffer.alloc(config.audio.frameRate * 2 * 6));
  await sleep(20);

  assert.deepEqual(errors, [], 'the agent must not apologise for its own echo cancellation');
});
