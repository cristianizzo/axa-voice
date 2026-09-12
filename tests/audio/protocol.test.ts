import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCommand, EventParser, PcmParser } from '../../src/audio/protocol.ts';

test('encodeCommand frames a command with a little-endian length', () => {
  const out = encodeCommand('A', Buffer.from([1, 2, 3, 4]));
  assert.equal(out.length, 9);
  assert.equal(String.fromCharCode(out[0]!), 'A');
  assert.equal(out.readUInt32LE(1), 4);
  assert.deepEqual([...out.subarray(5)], [1, 2, 3, 4]);
});

test('encodeCommand handles empty payloads', () => {
  const out = encodeCommand('F');
  assert.equal(out.length, 5);
  assert.equal(out.readUInt32LE(1), 0);
});

test('EventParser reassembles JSON split across chunk boundaries', () => {
  const p = new EventParser();
  assert.deepEqual(p.push(Buffer.from('{"type":"rea')), []);
  const events = p.push(Buffer.from('dy","rate":24000}\n'));
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, 'ready');
});

test('EventParser returns multiple events arriving in one chunk', () => {
  const p = new EventParser();
  const events = p.push(Buffer.from('{"type":"ready"}\n{"type":"stopped"}\n'));
  assert.deepEqual(
    events.map((e) => e.type),
    ['ready', 'stopped'],
  );
});

test('EventParser surfaces malformed lines instead of swallowing them', () => {
  const p = new EventParser();
  const events = p.push(Buffer.from('not json at all\n'));
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, 'malformed');
  assert.match((events[0] as { raw: string }).raw, /not json/);
});

test('PcmParser emits fixed-size frames and keeps the remainder', () => {
  const p = new PcmParser(320);
  // 500 samples = 1000 bytes: one 320-sample frame out, 180 samples held back.
  assert.equal(p.push(Buffer.alloc(1000)).length, 1);
  // 140 more samples completes the second frame exactly.
  assert.equal(p.push(Buffer.alloc(280)).length, 1);
  assert.equal(p.push(Buffer.alloc(0)).length, 0);
});

test('PcmParser preserves sample values across a split boundary', () => {
  const p = new PcmParser(2);
  const first = Buffer.alloc(3); // 1.5 samples: odd byte count
  first.writeInt16LE(-12345, 0);
  first[2] = 0x39;
  const second = Buffer.from([0x30]); // completes sample 2 as 0x3039 = 12345
  assert.deepEqual(p.push(first), []);
  const frames = p.push(second);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]![0], -12345);
  assert.equal(frames[0]![1], 12345);
});
