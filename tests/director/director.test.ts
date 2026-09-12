import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Director } from '../../src/director/director.ts';
import { loadConfig } from '../../src/config.ts';
import { makeFakes } from './fakes.ts';

const config = loadConfig({ CARTESIA_API_KEY: 'sk_test' });

test('a full turn walks LISTENING -> HEARING -> THINKING -> SPEAKING -> LISTENING', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();
  assert.equal(director.state, 'LISTENING');

  f.turns.speechStart();
  assert.equal(director.state, 'HEARING');

  f.transcriber.final('che ore sono');
  f.turns.turnEnd();
  await f.tick();
  assert.equal(director.state, 'THINKING');

  f.agent.emitText('Sono le tre.');
  await f.tick();
  assert.equal(director.state, 'SPEAKING');

  f.agent.emitDone();
  await f.tick();
  assert.equal(director.state, 'LISTENING');

  await director.stop();
});

test('barge-in flushes, interrupts, and reports what was actually heard', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();

  f.turns.speechStart();
  f.transcriber.final('raccontami una storia');
  f.turns.turnEnd();
  await f.tick();
  f.agent.emitText('Cera una volta un re che viveva in un castello.');
  await f.tick();
  assert.equal(director.state, 'SPEAKING');

  f.audioOut.heardMs = 1412.7;
  f.turns.speechStart();
  await f.tick();

  assert.equal(f.audioOut.flushes, 1, 'playback must be silenced');
  assert.equal(f.agent.interrupts, 1, 'interrupt(), never abort()');
  assert.equal(f.voice.aborts, 1, 'the TTS stream must be aborted');
  assert.equal(director.state, 'HEARING');

  f.transcriber.final('aspetta');
  f.turns.turnEnd();
  await f.tick();
  assert.ok(f.agent.interruptionNote, 'Claude must be told it was cut off');
  assert.match(f.agent.interruptionNote!.spokenSoFar, /Cera una volta/);
  assert.equal(f.agent.interruptionNote!.userSaid, 'aspetta');

  await director.stop();
});

test('the interruption note never claims more was heard than was played', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();

  f.turns.speechStart();
  f.transcriber.final('raccontami una storia');
  f.turns.turnEnd();
  await f.tick();
  f.agent.emitText('Cera una volta un re che viveva in un castello.');
  await f.tick();

  // Cut in almost immediately: the user heard the opening words and nothing else.
  f.audioOut.heardMs = 300;
  f.turns.speechStart();
  await f.tick();
  f.transcriber.final('aspetta');
  f.turns.turnEnd();
  await f.tick();

  const heard = f.agent.interruptionNote!.spokenSoFar;
  assert.ok(heard.length > 0, 'the opening words did reach the user');
  assert.ok(
    !heard.includes('castello'),
    'telling Claude the ending was heard is what makes it answer from a context the user never got',
  );

  await director.stop();
});

test('filler is spoken when the first token is slow', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();

  f.turns.speechStart();
  f.transcriber.final('cerca sul web il meteo');
  f.turns.turnEnd();
  await f.tick();

  f.advance(config.director.fillerAfterMs + 10);
  await f.tick();
  assert.ok(
    f.voice.spoken.some((s) => /guardo|aspetta|controllo/i.test(s)),
    'only the Director can see silence while it happens (spec §4)',
  );

  await director.stop();
});

test('a fast first token means no filler at all', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();

  f.turns.speechStart();
  f.transcriber.final('che ore sono');
  f.turns.turnEnd();
  await f.tick();
  f.agent.emitText('Sono le tre.');
  await f.tick();

  f.advance(config.director.fillerAfterMs + 10);
  await f.tick();
  assert.deepEqual(
    f.voice.spoken,
    ['Sono le tre.'],
    'a filler after the answer has started is the agent talking over itself',
  );

  await director.stop();
});

test('a write tool asks out loud and runs only on a spoken yes', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();

  f.turns.speechStart();
  f.transcriber.final('scrivi il file');
  f.turns.turnEnd();
  await f.tick();

  const decision = f.agent.requestPermission({ tool: 'Write', summary: 'scrivere su session.ts' });
  await f.tick();
  assert.equal(director.state, 'AWAITING_APPROVAL');
  assert.ok(f.voice.spoken.some((s) => /session/i.test(s)), 'the intent must be spoken');

  f.transcriber.final('sì');
  f.turns.turnEnd();
  await f.tick();
  assert.equal(await decision, true);
  assert.equal(director.state, 'THINKING');

  await director.stop();
});

test('the spoken approval question never dictates a path', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();

  f.turns.speechStart();
  f.transcriber.final('scrivi il file');
  f.turns.turnEnd();
  await f.tick();

  void f.agent.requestPermission({ tool: 'Write', summary: 'scrivere su src/agent/session.ts' });
  await f.tick();

  const question = f.voice.spoken.at(-1)!;
  assert.ok(!question.includes('/'), 'a path read out character by character is unusable');
  assert.match(question, /session punto ti esse/);

  f.advance(config.director.approvalTimeoutMs + 10);
  await f.tick();
  await director.stop();
});

test('an unclear answer denies AND becomes the next user turn', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();

  f.turns.speechStart();
  f.transcriber.final('scrivi il file');
  f.turns.turnEnd();
  await f.tick();

  const decision = f.agent.requestPermission({ tool: 'Write', summary: 'scrivere su session.ts' });
  await f.tick();

  f.transcriber.final('no aspetta volevo altro');
  f.turns.turnEnd();
  await f.tick();

  assert.equal(await decision, false, 'fail closed (spec §8)');
  assert.ok(
    f.agent.sent.includes('no aspetta volevo altro'),
    'the utterance was a new request, not a confirmation — it must not be swallowed',
  );

  await director.stop();
});

test('a plain no denies without starting a new turn', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();

  f.turns.speechStart();
  f.transcriber.final('scrivi il file');
  f.turns.turnEnd();
  await f.tick();

  const decision = f.agent.requestPermission({ tool: 'Write', summary: 'scrivere su session.ts' });
  await f.tick();

  f.transcriber.final('no');
  f.turns.turnEnd();
  await f.tick();

  assert.equal(await decision, false);
  assert.deepEqual(f.agent.sent, ['scrivi il file'], '"no" is an answer, not a new request');
  assert.equal(director.state, 'THINKING', 'the turn it was asking about is still running');

  await director.stop();
});

test('a hallucinated transcript never approves a write', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();

  f.turns.speechStart();
  f.transcriber.final('scrivi il file');
  f.turns.turnEnd();
  await f.tick();

  const decision = f.agent.requestPermission({ tool: 'Write', summary: 'scrivere su session.ts' });
  await f.tick();
  f.transcriber.final('[Musica]');
  f.turns.turnEnd();
  await f.tick();

  assert.equal(await decision, false);
  assert.deepEqual(f.agent.sent, ['scrivi il file'], 'noise is not a request either');

  await director.stop();
});

test('silence during an approval times out into a denial', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();

  f.turns.speechStart();
  f.transcriber.final('scrivi il file');
  f.turns.turnEnd();
  await f.tick();

  const decision = f.agent.requestPermission({ tool: 'Write', summary: 'scrivere su session.ts' });
  await f.tick();
  f.advance(config.director.approvalTimeoutMs + 10);
  await f.tick();

  assert.equal(await decision, false, 'a user who walked away must not hang the session');
  assert.equal(director.state, 'LISTENING');

  await director.stop();
});

test('an empty turn is dropped instead of being sent', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();

  f.turns.speechStart();
  f.transcriber.final('[Musica]');
  f.turns.turnEnd();
  await f.tick();

  assert.deepEqual(f.agent.sent, [], 'a hallucination is not a turn');
  assert.equal(director.state, 'LISTENING');

  await director.stop();
});

test('audio is only transcribed while the user is being heard', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();

  f.audioIn.frame();
  assert.equal(f.transcriber.current!.pushed.length, 0, 'silence must not reach whisper');

  f.turns.speechStart();
  f.audioIn.frame();
  assert.equal(f.transcriber.current!.pushed.length, 1);
  assert.equal(f.turns.pushed.length, 2, 'the detector, though, sees every frame');

  await director.stop();
});

test('an audio device error is spoken, not swallowed', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();
  f.audioIn.fail('microphone delivered only digital silence for 2s');
  await f.tick();
  assert.ok(f.errors.length > 0, 'never fail silently into a dead microphone (spec §9)');
  assert.ok(f.voice.spoken.length > 0, 'and the user, who cannot read the log, is told');

  await director.stop();
});

test('the voice connection is warmed at startup, not on the first turn', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();
  assert.equal(f.voice.prewarms, 1, '458-500ms of handshake that does not amortise');
  await director.stop();
  assert.equal(f.voice.closes, 1);
});
