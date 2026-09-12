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

test('speech while thinking does not interrupt the turn', async () => {
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();
  // First token not yet emitted: FakeAgentSession.send() blocks until an event
  // is pushed, so the Director simply sits in THINKING.
  f.turns.speechStart();
  f.transcriber.final('quando gioca il napoli');
  f.turns.turnEnd();
  await f.tick();
  assert.equal(d.state, 'THINKING');

  // An agent at work is not a user talking: the room is still silent.
  f.audioIn.frame();
  assert.equal(f.transcriber.current!.pushed.length, 0, 'THINKING alone does not capture');

  // The prompt that used to kill the search.
  f.turns.speechStart();
  f.audioIn.frame();
  assert.equal(
    f.transcriber.current!.pushed.length,
    1,
    'but THINKING must record the user, which is the whole point of not barging in',
  );
  f.transcriber.final('allora');
  f.turns.turnEnd();
  await f.tick();
  assert.equal(f.agent.interrupts, 0, 'thinking is not interruptible');
  assert.equal(d.state, 'THINKING', 'the turn survives');

  // ...and capture stops with the utterance, rather than running for the
  // lifetime of the answer.
  f.audioIn.frame();
  assert.equal(f.transcriber.current!.pushed.length, 0, 'a routed turn ends capture');

  await d.stop();
});

test('speech while speaking still interrupts', async () => {
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();
  f.turns.speechStart();
  f.transcriber.final('domanda');
  f.turns.turnEnd();
  await f.tick();
  f.agent.emitText('Questa è una risposta lunga.');
  await f.tick();
  assert.equal(d.state, 'SPEAKING');

  f.audioIn.frame();
  assert.equal(f.transcriber.current!.pushed.length, 0, 'an answer playing is not speech to record');

  f.turns.speechStart();
  f.audioIn.frame();
  f.transcriber.final('no aspetta');
  await f.tick();
  assert.equal(f.agent.interrupts, 1, 'barge-in is the whole point of the project');
  assert.equal(f.transcriber.current!.pushed.length, 1, 'and what was said over it is captured');

  await d.stop();
});

test('speech that outlasts the first sentence is a follow-up, not a dropped turn', async () => {
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();
  f.turns.speechStart();
  f.transcriber.final('cerca il meteo');
  f.turns.turnEnd();
  await f.tick();
  assert.equal(d.state, 'THINKING');

  // The user starts talking while the agent works, then the answer's first
  // sentence lands mid-utterance: #run flips the state under them. Nothing
  // about what they are saying changed, so nothing about its routing may.
  f.turns.speechStart();
  f.audioIn.frame();
  f.agent.emitText('A Valenza ci sono venti gradi.');
  await f.tick();
  assert.equal(d.state, 'SPEAKING', 'the answer started while they were still talking');
  f.audioIn.frame();
  assert.equal(f.transcriber.current!.pushed.length, 2, 'capture survives the state flip');

  const streams = f.transcriber.opened.length;
  f.transcriber.final('e domani');
  f.turns.turnEnd();
  await f.tick();

  // Nothing drains the queue until the next task, so the observable proof that
  // the utterance was routed rather than dropped is that it was collected at
  // all: the final transcription is forced, which closes the stream and opens
  // its replacement. A dropped turn returns before any of that happens.
  assert.equal(f.transcriber.opened.length, streams + 1, 'the utterance was taken, not dropped');
  assert.equal(f.transcriber.opened.at(-2)!.closed, true, 'and the final was forced out of whisper');
  assert.equal(f.agent.interrupts, 0, 'a follow-up still does not cancel the work');
  assert.equal(d.state, 'SPEAKING', 'the answer keeps playing');

  f.audioIn.frame();
  assert.equal(
    f.transcriber.current!.pushed.length,
    0,
    'capture must stop with the utterance, not run for the length of the answer',
  );

  await d.stop();
});

test('a follow-up said while thinking is answered after the current answer', async () => {
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();
  // First token not yet emitted: FakeAgentSession.send() blocks until an event
  // is pushed, so the Director simply sits in THINKING.
  f.turns.speechStart();
  f.transcriber.final('quando gioca il napoli');
  f.turns.turnEnd();
  await f.tick();

  f.turns.speechStart();
  f.transcriber.final('e anche che tempo fa');
  f.turns.turnEnd();
  await f.tick();

  f.agent.emitText('Gioca domenica.');
  await f.tick();
  f.agent.emitDone();
  await f.tick();

  assert.deepEqual(f.agent.sent, ['quando gioca il napoli', 'e anche che tempo fa']);

  await d.stop();
});

test('a hallucinated transcript is never queued', async () => {
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();
  f.turns.speechStart();
  f.transcriber.final('domanda');
  f.turns.turnEnd();
  await f.tick();

  f.turns.speechStart();
  f.transcriber.final('[Musica]');
  f.turns.turnEnd();
  await f.tick();
  f.agent.emitText('Risposta.');
  await f.tick();
  f.agent.emitDone();
  await f.tick();

  assert.deepEqual(f.agent.sent, ['domanda'], 'a cough is not a question');

  await d.stop();
});

test('a bare stop command while thinking cancels the turn', async () => {
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();
  f.turns.speechStart();
  f.transcriber.final('cerca qualcosa');
  f.turns.turnEnd();
  await f.tick();

  f.turns.speechStart();
  f.audioIn.frame();
  assert.equal(f.transcriber.current!.pushed.length, 1, 'the stop word has to reach whisper first');
  f.transcriber.final('basta');
  f.turns.turnEnd();
  await f.tick();
  assert.equal(f.agent.interrupts, 1);
  assert.equal(d.state, 'LISTENING');

  f.audioIn.frame();
  assert.equal(f.transcriber.current!.pushed.length, 0, 'and capture ends with the turn');

  await d.stop();
});

test('a stop command that races a permission request does not strand it', async () => {
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();
  f.turns.speechStart();
  f.transcriber.final('scrivi il file');
  f.turns.turnEnd();
  await f.tick();
  assert.equal(d.state, 'THINKING');

  f.turns.speechStart();
  f.transcriber.final('basta');
  f.turns.turnEnd();
  // Deliberately no tick: the request lands while #onTurnEnd is suspended in
  // the round trip that forces the final transcription. That does not bump
  // #turnId, so the stop branch goes on to run on top of an approval that is
  // already outstanding.
  const decision = f.agent.requestPermission({ tool: 'Write', summary: 'scrivere su session.ts' });
  await f.tick();
  assert.equal(d.state, 'LISTENING');

  f.advance(config.director.approvalTimeoutMs + 10);
  await f.tick();
  assert.equal(await decision, false, 'a cancelled turn denies what it was about to ask');
  assert.ok(
    !f.voice.spoken.some((s) => /lascio stare/i.test(s)),
    'a timer left armed on a dead approval speaks GAVE_UP into an unrelated moment later',
  );

  await d.stop();
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

  // Half the answer was still sitting in the queue when the user cut in.
  f.audioOut.pendingMs = f.audioOut.enqueuedMs / 2;
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
  f.audioOut.pendingMs = f.audioOut.enqueuedMs - 300;
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

test('the second barge-in is measured as carefully as the first', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();

  f.turns.speechStart();
  f.transcriber.final('raccontami una storia');
  f.turns.turnEnd();
  await f.tick();
  f.agent.emitText('Cera una volta un re che viveva in un castello.');
  await f.tick();

  f.audioOut.pendingMs = f.audioOut.enqueuedMs / 2;
  f.turns.speechStart();
  await f.tick();
  f.transcriber.final('aspetta');
  f.turns.turnEnd();
  await f.tick();

  // Turn two. The device's counter keeps climbing from where turn one left it:
  // it has no idea a new turn started. Measuring the new answer against a total
  // that restarted at zero makes every cut-off from here on look complete.
  const answerStartedAt = f.audioOut.enqueuedMs;
  f.agent.emitText('Il secondo re invece viveva dentro una torre altissima.');
  await f.tick();
  assert.equal(director.state, 'SPEAKING');

  f.audioOut.pendingMs = f.audioOut.enqueuedMs - (answerStartedAt + 300);
  f.turns.speechStart();
  await f.tick();
  f.transcriber.final('no basta');
  f.turns.turnEnd();
  await f.tick();

  const heard = f.agent.interruptionNote!.spokenSoFar;
  assert.ok(heard.length > 0, 'the opening words did reach the user');
  assert.ok(
    !heard.includes('torre'),
    'claiming the whole answer was heard is what makes Claude answer from a context the user never got',
  );
  assert.ok(!heard.includes('castello'), 'and the previous turn is not part of this answer');

  await director.stop();
});

test('a filler already speaking is cut off by the answer, not left to overlap', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();

  f.turns.speechStart();
  f.transcriber.final('cerca sul web il meteo');
  f.turns.turnEnd();
  await f.tick();

  // The filler starts speaking, and the first sentence lands while it is still
  // going. Cancelling only the timer leaves the two talking over each other.
  f.advance(config.director.fillerAfterMs + 10);
  f.agent.emitText('A Valenza ci sono venti gradi.');
  await f.tick();

  assert.equal(f.voice.aborts, 1, 'the filler must be silenced, not merely un-scheduled');
  assert.ok(f.voice.spoken.includes('A Valenza ci sono venti gradi.'));

  await director.stop();
});

test('a long answer waits for the speakers instead of overflowing the queue', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();

  // The device queue holds four seconds and the voice is far faster than
  // speech. Full at first, then draining.
  let checks = 0;
  f.audioOut.bufferedMs = () => (checks++ < 3 ? 3000 : 0);

  f.turns.speechStart();
  f.transcriber.final('raccontami una storia lunga');
  f.turns.turnEnd();
  await f.tick();
  f.agent.emitText('Cera una volta un re.');
  f.agent.emitDone();
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.ok(checks > 3, 'the answer must wait while the queue is full');
  assert.ok(f.audioOut.frames.length > 0, 'and then arrive whole, not truncated');
  assert.equal(director.state, 'LISTENING');

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
