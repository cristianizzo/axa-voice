import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VadTurnDetector, stablePrefix, looksUnfinished } from '../../src/turn/detector.ts';
import { loadConfig } from '../../src/config.ts';

const config = loadConfig({ CARTESIA_API_KEY: 'sk_test' });
const loud = () => Int16Array.from({ length: 320 }, () => 8000);
const quiet = () => new Int16Array(320);
/** The tail of a word: too quiet to start a turn, too loud to be a room. */
const soft = () => Int16Array.from({ length: 320 }, () => 300);

test('stablePrefix drops the unreliable tail', () => {
  assert.equal(stablePrefix('uno due tre quattro', 2), 'uno due');
  assert.equal(stablePrefix('uno', 2), '');
  assert.equal(stablePrefix('', 2), '');
});

test('the real churning-tail sequence converges once the tail is dropped', () => {
  // Measured partials: the prefix settles several passes before the tail does.
  const a = 'Ciao, puoi controllare i log di ieri per favore';
  const b = 'Ciao, puoi controllare i log di ieri per favore, mi serve sa';
  assert.notEqual(a, b, 'whole-string comparison would never converge');
  assert.equal(stablePrefix(a, 2), stablePrefix(b.slice(0, a.length), 2));
});

test('looksUnfinished catches trailing conjunctions', () => {
  assert.equal(looksUnfinished('apri il file e'), true);
  assert.equal(looksUnfinished('controlla i log ma'), true);
  assert.equal(looksUnfinished('apri il file'), false);
});

test('fires onSpeechStart when energy rises', () => {
  let started = 0;
  const d = new VadTurnDetector(config);
  d.onSpeechStart(() => started++);
  for (let i = 0; i < 5; i++) d.push(loud(), null);
  assert.equal(started, 1, 'must fire once per turn, not once per frame');
});

test('ends the turn after 250ms of silence with a stable transcript', () => {
  let now = 0;
  const d = new VadTurnDetector(config, { now: () => now });
  let ended = 0;
  d.onTurnEnd(() => ended++);

  for (let i = 0; i < 10; i++) { now += 20; d.push(loud(), 'apri il file adesso'); }
  assert.equal(ended, 0);
  for (let i = 0; i < 13; i++) { now += 20; d.push(quiet(), 'apri il file adesso'); }
  assert.equal(ended, 1, 'stable transcript plus 250ms of silence ends the turn');
});

test('extends to 700ms when the transcript looks unfinished', () => {
  let now = 0;
  const d = new VadTurnDetector(config, { now: () => now });
  let ended = 0;
  d.onTurnEnd(() => ended++);

  for (let i = 0; i < 10; i++) { now += 20; d.push(loud(), 'apri il file e'); }
  for (let i = 0; i < 13; i++) { now += 20; d.push(quiet(), 'apri il file e'); }
  assert.equal(ended, 0, 'a trailing conjunction must not end the turn at 250ms');
  for (let i = 0; i < 25; i++) { now += 20; d.push(quiet(), 'apri il file e'); }
  assert.equal(ended, 1, 'but it must end by 700ms');
});

test('a pause before any transcript exists gets the long window', () => {
  // Measured on real speech: "Ciao, puoi controllare…" has a 260ms comma pause,
  // and the first partial only lands ~800ms in. With no transcript there is no
  // stability evidence at all, so the short window would cut the user off after
  // one word. An absent transcript is the most unfinished state there is.
  let now = 0;
  const d = new VadTurnDetector(config, { now: () => now });
  let ended = 0;
  d.onTurnEnd(() => ended++);

  for (let i = 0; i < 10; i++) { now += 20; d.push(loud(), null); }
  for (let i = 0; i < 13; i++) { now += 20; d.push(quiet(), null); }
  assert.equal(ended, 0, 'a comma pause must not end a turn that has no transcript yet');
  for (let i = 0; i < 25; i++) { now += 20; d.push(quiet(), null); }
  assert.equal(ended, 1, 'but silence must still end the turn eventually');
});

test('a quiet speech tail does not count as silence once the turn is running', () => {
  // Energy hysteresis: measured frames between words sit at 200–500 RMS, below
  // the onset threshold. Treating them as silence ends turns mid-sentence.
  let now = 0;
  const d = new VadTurnDetector(config, { now: () => now });
  let ended = 0;
  d.onTurnEnd(() => ended++);

  for (let i = 0; i < 10; i++) { now += 20; d.push(loud(), 'apri il file adesso'); }
  for (let i = 0; i < 30; i++) { now += 20; d.push(soft(), 'apri il file adesso'); }
  assert.equal(ended, 0, '600ms of quiet speech tail is still speech');
  for (let i = 0; i < 15; i++) { now += 20; d.push(quiet(), 'apri il file adesso'); }
  assert.equal(ended, 1, 'real silence still ends it');
});

test('a quiet frame on its own does not start a turn', () => {
  let started = 0;
  const d = new VadTurnDetector(config);
  d.onSpeechStart(() => started++);
  for (let i = 0; i < 10; i++) d.push(soft(), null);
  assert.equal(started, 0, 'the onset threshold is higher than the continuation one');
});

test('residual echo above the ordinary onset threshold does not start a turn during self-play', () => {
  // Between the ordinary onset (500) and the self-play one (1500): loud enough
  // to be mistaken for speech by the normal bar, but the level AEC's own
  // measured worst case (+0.7 dB on a steady tone) can plausibly leave behind
  // from the Director's own voice.
  const echo = () => Int16Array.from({ length: 320 }, () => 900);
  let started = 0;
  const d = new VadTurnDetector(config);
  d.onSpeechStart(() => started++);
  for (let i = 0; i < 10; i++) d.push(echo(), null, true);
  assert.equal(started, 0, 'residual echo must not be read as a barge-in');

  // The same level, with self-play not active, is an ordinary onset.
  for (let i = 0; i < 10; i++) d.push(echo(), null, false);
  assert.equal(started, 1, 'the same level is a real onset once the room is actually quiet');
});

test('a real barge-in still clears the raised self-play threshold', () => {
  let started = 0;
  const d = new VadTurnDetector(config);
  d.onSpeechStart(() => started++);
  for (let i = 0; i < 10; i++) d.push(loud(), null, true);
  assert.equal(started, 1, 'a user actually speaking is well above residual echo, self-play or not');
});

test('silence alone does not end the turn while the transcript is still growing', () => {
  // Spec §5 ends a turn on VAD silence AND a stable transcript. Partials arrive on
  // a 350ms timer, so one can land after the user has already stopped and extend
  // the stable prefix — the turn must wait for it to settle.
  let now = 0;
  const d = new VadTurnDetector(config, { now: () => now });
  let ended = 0;
  d.onTurnEnd(() => ended++);

  for (let i = 0; i < 10; i++) { now += 20; d.push(loud(), 'apri il file'); }
  for (let i = 0; i < 5; i++) { now += 20; d.push(quiet(), 'apri il file'); }
  // A late partial lands at 320ms and grows the stable prefix.
  for (let i = 0; i < 12; i++) { now += 20; d.push(quiet(), 'apri il file adesso subito'); }
  assert.equal(ended, 0, 'the prefix moved at 320ms, so 250ms of silence is not enough');
  for (let i = 0; i < 3; i++) { now += 20; d.push(quiet(), 'apri il file adesso subito'); }
  assert.equal(ended, 1, 'once the prefix has held for 250ms the turn ends');
});

test('a churning tail still ends the turn', () => {
  let now = 0;
  const d = new VadTurnDetector(config, { now: () => now });
  let ended = 0;
  d.onTurnEnd(() => ended++);

  for (let i = 0; i < 10; i++) { now += 20; d.push(loud(), 'apri il file adesso'); }
  // The tail keeps changing on every frame, exactly as measured.
  const tails = ['adesso', 'ades', 'adessoo', 'adesso'];
  for (let i = 0; i < 13; i++) {
    now += 20;
    d.push(quiet(), `apri il file ${tails[i % tails.length]}`);
  }
  assert.equal(ended, 1, 'the churning tail must not block the turn from ending');
});
