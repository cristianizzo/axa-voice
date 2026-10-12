import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Director } from '../../src/director/director.ts';
import { loadConfig } from '../../src/config.ts';
import { REQUEST_TIMEOUT_MS } from '../../src/stt/transcriber.ts';
import { makeFakes } from './fakes.ts';
import type { AudioFrame, Voice } from '../../src/types.ts';

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

test('speech while speaking mutes the answer, but only an explicit stop cancels it', async () => {
  // Follow-up to a real incident (spec: 2026-09-27): an AEC-suppressed echo
  // of the Director's own voice crossed the onset threshold mid-answer and
  // was treated as "the user is interrupting", killing a running LinkedIn
  // search the user never asked to stop. Onset must still silence the
  // speakers instantly (that part is unconditional — talking over the user
  // is its own bug), but the agent turn itself is only cancelled once the
  // recaptured utterance's content says so.
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
  assert.equal(d.state, 'HEARING', 'onset alone moves state, before anything is known about content');
  assert.equal(f.voice.aborts, 1, 'the currently playing TTS must be silenced immediately, on onset alone');
  f.audioIn.frame();
  assert.equal(f.transcriber.current!.pushed.length, 1, 'and what was said over it is captured');
  assert.equal(f.agent.interrupts, 0, 'nothing is cancelled before the recapture even finishes');

  f.transcriber.final('no aspetta');
  f.turns.turnEnd();
  await f.tick();
  assert.equal(f.agent.interrupts, 0, '"aspetta" is deliberately not a stop command (approval.ts)');
  assert.deepEqual(f.agent.sent, ['domanda'], 'not a new question either — it is a follow-up, queued');

  // The turn's own work was never touched: it goes on to finish normally.
  f.agent.emitDone();
  await f.tick();
  assert.deepEqual(
    f.agent.sent,
    ['domanda', 'no aspetta'],
    'the queued follow-up is dispatched once the original answer finishes',
  );

  await d.stop();
});

test('a background tool call survives a non-stop interruption of the answer that follows it', async () => {
  // The exact shape of the original incident: a search was already running
  // when the first sentence of the answer started playing, an onset fired
  // mid-sentence, and the recapture was not a stop command. The search must
  // be left completely alone — nothing here waits for it or cancels it — and
  // must still be allowed to finish and have its result narrated once the
  // answer resumes.
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();
  f.turns.speechStart();
  f.transcriber.final('cerca qualcosa su linkedin');
  f.turns.turnEnd();
  await f.tick();

  // The tool starts, and only after does the model narrate a first sentence
  // — same order a real "let me check that" opener would arrive in.
  f.agent.emitTool('WebSearch', 'start');
  await f.tick();
  f.agent.emitText('Fammi controllare.');
  await f.tick();
  assert.equal(d.state, 'SPEAKING');

  // Onset mid-sentence; what got recaptured over it transcribes to nothing
  // (an echo, a stray sound) — not a stop command, and nothing to queue.
  f.turns.speechStart();
  assert.equal(f.voice.aborts, 1, 'the answer is silenced instantly');
  f.transcriber.final('');
  f.turns.turnEnd();
  await f.tick();
  assert.equal(f.agent.interrupts, 0, 'the running tool call is never cancelled by an onset alone');

  // The search keeps running regardless of the pause, and finishes on its
  // own schedule — nothing the Director did was waiting on it.
  f.agent.emitTool('WebSearch', 'end');
  f.agent.emitText('Ho trovato tre profili.');
  f.agent.emitDone();
  await f.tick();

  assert.deepEqual(
    f.voice.spoken,
    ['Fammi controllare.', 'Ho trovato tre profili.'],
    'the answer resumes and the tool result is narrated, exactly as if nothing had interrupted it',
  );
  assert.equal(d.state, 'LISTENING');

  await d.stop();
});

test('a second barge-in after a non-stop resume still mutes, and is still a barge-in, not a fresh question', async () => {
  // Regression test for a bug found in code review (2026-09-27): the
  // non-stop resume branch left `#state` at HEARING instead of restoring
  // SPEAKING once the recapture's transcript said the first onset was not a
  // stop command. `#onSpeechStart` returns early for HEARING, so a SECOND
  // onset during that same (resumed) answer never called `#muteForBargeIn`
  // again, and — because `capturingFrom` then read 'HEARING', not
  // 'SPEAKING' — its recapture fell through to `#ask()`, starting a second,
  // concurrent `agent.send()` over the still-live first one.
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();

  f.turns.speechStart();
  f.transcriber.final('raccontami una storia');
  f.turns.turnEnd();
  await f.tick();
  f.agent.emitText('Cera una volta un re che viveva in un castello.');
  await f.tick();
  assert.equal(d.state, 'SPEAKING');

  // First onset: not a stop, an ordinary follow-up recapture.
  f.turns.speechStart();
  await f.tick();
  assert.equal(f.voice.aborts, 1, 'the first onset silences the answer');
  f.transcriber.final('no aspetta');
  f.turns.turnEnd();
  await f.tick();
  assert.equal(f.agent.interrupts, 0, 'not a stop command, nothing cancelled');
  assert.equal(
    d.state,
    'SPEAKING',
    'the resumed answer must read as SPEAKING again, not stuck at HEARING',
  );

  // Second onset, over the SAME resumed answer.
  f.turns.speechStart();
  await f.tick();
  assert.equal(
    f.voice.aborts,
    2,
    'a second onset must mute again — this is the whole point of restoring SPEAKING on resume',
  );
  f.transcriber.final('basta');
  f.turns.turnEnd();
  await f.tick();

  assert.equal(f.agent.interrupts, 1, 'the explicit stop this time does cancel the turn');
  assert.deepEqual(
    f.agent.sent,
    ['raccontami una storia'],
    'the stop word must never be dispatched as a second, concurrent question',
  );
  assert.equal(d.state, 'LISTENING');

  await d.stop();
});

test('a sentence fed to the voice far ahead of what has actually rendered is not skipped on resume', async () => {
  // Regression test for code review finding (2026-09-27, round 3): a real
  // Voice's own `feeding` task (cartesia.ts:277-286) is an unbounded,
  // backpressure-free drain — it pulls sentences from the Director as fast
  // as they exist, entirely independent of `#waitForRoom`'s throttle on the
  // render side. The old code counted a sentence as "spoken" the instant it
  // was handed to that eager feed, so a barge-in landing while the device
  // queue was still full (sentence 2/3 already fed, but not yet a single
  // frame of them rendered) skipped them permanently on resume — the resume
  // cursor trusted the feed side, not the render side.
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();

  f.turns.speechStart();
  f.transcriber.final('raccontami tre cose');
  f.turns.turnEnd();
  await f.tick();

  // 'Prima frase.' is exactly 12 characters, which FakeVoice's own 70ms/char,
  // 20ms/frame pace turns into exactly 42 frames of 20ms each — 840ms. The
  // device reports itself full from the 42nd frame on, so sentence 1 finishes
  // rendering in full and sentence 2's first frame is the one that stalls.
  f.audioOut.bufferedMs = () => (f.audioOut.frames.length >= 42 ? 9999 : 0);

  f.agent.emitText('Prima frase.');
  f.agent.emitText('Seconda frase.');
  f.agent.emitText('Terza frase.');
  // No fake timer here on purpose: #waitForRoom polls with the real clock
  // (director.ts), not the injected `Timers`, so this has to be a real wait.
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(d.state, 'SPEAKING');
  assert.equal(f.audioOut.enqueuedMs, 840, 'only the first sentence has actually reached the device');
  assert.deepEqual(
    f.voice.spoken,
    ['Prima frase.', 'Seconda frase.', 'Terza frase.'],
    "the eager feed has already pulled all three — that's the gap this bug lived in",
  );

  // Onset mid-stall. `#tts.abort()` (inside `#muteForBargeIn`) fires
  // synchronously, so the abort listener does too — no tick needed for this
  // part. The queue is empty again on the other side of it, exactly like a
  // real flush.
  f.turns.speechStart();
  assert.equal(f.voice.aborts, 1);
  f.audioOut.bufferedMs = () => 0;

  // `#play()` itself is still parked inside `#waitForRoom`'s real
  // `setTimeout(..., PLAYBACK_POLL_MS)` poll — it only notices the abort on
  // that poll's NEXT wake-up, not synchronously. `f.tick()` alone (a fixed
  // number of `setImmediate` turns, no real waiting) is not guaranteed to
  // span that real delay, so without this wait the test is racing
  // `#waitForRoom`'s own clock — sometimes losing it, and asserting on a
  // turn that has not actually resumed yet.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await f.tick();

  // Not a stop command, so the paused turn resumes.
  f.transcriber.final('no aspetta');
  f.turns.turnEnd();
  await f.tick();
  assert.equal(f.agent.interrupts, 0);

  f.agent.emitDone();
  await f.tick();

  assert.equal(
    f.voice.spoken.filter((s) => s === 'Prima frase.').length,
    1,
    'the sentence that actually rendered must not be repeated',
  );
  assert.equal(
    f.voice.spoken.filter((s) => s === 'Seconda frase.').length,
    2,
    'fed but never rendered before the pause: it must be spoken again on resume, not silently skipped',
  );
  assert.equal(
    f.voice.spoken.filter((s) => s === 'Terza frase.').length,
    2,
    'same for the sentence after it',
  );

  await d.stop();
});

test('a sentence the agent produces while paused for a barge-in is still spoken once resumed', async () => {
  // Regression test for code review finding #2 (2026-09-27): relay()'s
  // shared read cursor used to be a single index shared by every view it
  // handed out. A sentence produced while paused would wake whichever
  // reader was suspended holding the (also shared) wake slot — which could
  // be the reader from BEFORE the pause, whose own `voice.synthesize()` call
  // had already aborted and silently discards anything handed to it — and
  // that reader's cursor advancing past the sentence left it permanently
  // unreachable to the fresh view the resumed `#play()` call goes on to
  // create, as if it had been spoken when it never was.
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();

  f.turns.speechStart();
  f.transcriber.final('raccontami una storia');
  f.turns.turnEnd();
  await f.tick();
  f.agent.emitText('Cera una volta un re.');
  await f.tick();
  assert.equal(d.state, 'SPEAKING');

  // Onset mid-first-sentence. The recapture's own final transcript has not
  // landed yet — #onTurnEnd is still waiting on that round trip — which is
  // exactly the window in which the agent keeps producing more of the
  // answer, with no idea any of this is happening.
  f.turns.speechStart();
  await f.tick();
  assert.equal(f.voice.aborts, 1);

  f.agent.emitText('Viveva in un castello lontano.');
  f.agent.emitText('E aveva tre figlie bellissime.');
  await f.tick();

  // Only now does the recapture's final transcript arrive — an ordinary
  // follow-up, not a stop command, so the paused turn resumes.
  f.transcriber.final('no aspetta');
  f.turns.turnEnd();
  await f.tick();
  assert.equal(f.agent.interrupts, 0);

  f.agent.emitDone();
  await f.tick();

  assert.deepEqual(
    f.voice.spoken,
    ['Cera una volta un re.', 'Viveva in un castello lontano.', 'E aveva tre figlie bellissime.'],
    'every sentence the agent produced must actually reach the voice — none silently dropped',
  );
  // "no aspetta" was a non-empty, non-stop recapture, so — same as an
  // ordinary follow-up said while speaking (see the test above this one) —
  // it was queued behind the answer and dispatched the instant it finished,
  // which starts the next turn immediately. LISTENING is not reached because
  // there is more to do, not because anything was dropped.
  assert.deepEqual(f.agent.sent, ['raccontami una storia', 'no aspetta']);
  assert.equal(d.state, 'THINKING');

  await d.stop();
});

test('an explicit stop word during speaking does cancel the turn', async () => {
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();
  f.turns.speechStart();
  f.transcriber.final('cerca qualcosa su linkedin');
  f.turns.turnEnd();
  await f.tick();
  f.agent.emitText('Questa è una risposta lunga.');
  await f.tick();
  assert.equal(d.state, 'SPEAKING');

  f.turns.speechStart();
  f.audioIn.frame();
  f.transcriber.final('basta');
  f.turns.turnEnd();
  await f.tick();

  assert.equal(f.agent.interrupts, 1, 'a genuine stop word does cancel the turn, and its search');
  assert.equal(d.state, 'LISTENING');
  assert.deepEqual(f.agent.sent, ['cerca qualcosa su linkedin'], 'the stop word is never sent as a question');

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

test('a follow-up that is still being said when the answer ends is still a turn', async () => {
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();
  f.turns.speechStart();
  f.transcriber.final('quando gioca il napoli');
  f.turns.turnEnd();
  await f.tick();
  assert.equal(d.state, 'THINKING');

  // The user starts talking while the agent works — and is still talking when
  // the whole answer has played out. #run returns the state to LISTENING under
  // them, so turnEnd arrives in a state that no longer remembers why they were
  // being recorded.
  f.turns.speechStart();
  f.audioIn.frame();
  f.agent.emitText('Gioca domenica.');
  f.agent.emitDone();
  await f.tick();
  assert.equal(d.state, 'LISTENING', 'the answer finished while they were still mid-sentence');

  f.transcriber.final('e anche che tempo fa');
  f.turns.turnEnd();
  await f.tick();

  assert.deepEqual(
    f.agent.sent,
    ['quando gioca il napoli', 'e anche che tempo fa'],
    'a question swallowed because the answer happened to end first is indistinguishable from being ignored',
  );
  assert.equal(d.state, 'THINKING', 'and it is an ordinary turn, like any other');

  await d.stop();
});

test('a stop word arriving after the turn already ended is an ordinary utterance', async () => {
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();
  f.turns.speechStart();
  f.transcriber.final('cerca qualcosa');
  f.turns.turnEnd();
  await f.tick();

  f.turns.speechStart();
  f.audioIn.frame();
  f.agent.emitText('Ecco qua.');
  f.agent.emitDone();
  await f.tick();
  assert.equal(d.state, 'LISTENING');

  f.transcriber.final('basta');
  f.turns.turnEnd();
  await f.tick();

  assert.equal(f.agent.interrupts, 0, 'with nothing in flight there is nothing to stop');
  assert.deepEqual(
    f.agent.sent,
    ['cerca qualcosa', 'basta'],
    'a stop word cancels a turn that is still running; into an idle agent it is just something the user said',
  );

  await d.stop();
});

test('a gui toggle command never reaches Claude', async () => {
  const f = makeFakes(config, {
    runGui: async (mode) => `called with ${mode}`,
  });
  const d = new Director(f.deps);
  await d.start();

  f.turns.speechStart();
  f.transcriber.final('attiva la gui');
  f.turns.turnEnd();
  await f.tick();

  assert.deepEqual(f.agent.sent, [], 'the deny-listed Bash(gui on:*) rule must never be reached');
  assert.equal(d.state, 'LISTENING');
  assert.deepEqual(
    f.voice.spoken,
    ['called with on'],
    'the confirmation is a line the Director says itself, not an answer from Claude',
  );

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

test('a stop word said while thinking cancels even after a permission prompt lands', async () => {
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();
  f.turns.speechStart();
  f.transcriber.final('scrivi il file');
  f.turns.turnEnd();
  await f.tick();
  assert.equal(d.state, 'THINKING');

  // The user starts a follow-up while the agent works...
  f.turns.speechStart();
  f.audioIn.frame();

  // ...and, still mid-sentence, the agent reaches a tool needing permission:
  // the Director asks out loud and the state moves to AWAITING_APPROVAL.
  const decision = f.agent.requestPermission({ tool: 'Write', summary: 'scrivere su session.ts' });
  await f.tick();
  assert.equal(d.state, 'AWAITING_APPROVAL');

  f.transcriber.final('basta');
  f.turns.turnEnd();
  await f.tick();

  assert.equal(f.agent.interrupts, 1, 'basta cancels the turn, not just the permission');
  assert.equal(d.state, 'LISTENING');
  assert.equal(await decision, false, 'the outstanding approval is resolved, not stranded');
  assert.deepEqual(f.agent.sent, ['scrivi il file'], 'basta is not re-dispatched as a new turn');

  await d.stop();
});

test('a permission request landing mid SPEAKING barge-in pause is not orphaned by the non-stop resume', async () => {
  // Reproduces a real bug found in review (2026-09-27): a permission request
  // is driven by the SDK's own `canUseTool` callback, entirely independent of
  // `#pausedForBargeIn` — it can land while a SPEAKING-onset barge-in's
  // recapture is still being finalised. Before this fix, `#onTurnEnd`'s
  // "not a stop command, resume the same turn" branch unconditionally
  // restored `#state = 'SPEAKING'` once the recapture settled, clobbering the
  // AWAITING_APPROVAL the permission request had already set. The user's real
  // answer to the approval question then misread as a second barge-in onset
  // instead of routing to `#answer()`, and was silently discarded once
  // `#onPermission`'s own timeout eventually gave up.
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();

  f.turns.speechStart();
  f.transcriber.final('scrivi il file di configurazione');
  f.turns.turnEnd();
  await f.tick();
  f.agent.emitText('Va bene, lo scrivo subito.');
  await f.tick();
  assert.equal(d.state, 'SPEAKING');

  // Onset barge-in: instant mute, recapture starts.
  f.turns.speechStart();
  assert.equal(d.state, 'HEARING');
  await f.tick(); // let #muteForBargeIn's flush settle before the recapture's own final lands

  // The recapture's final transcript lands and `turnEnd()` forces it — but,
  // deliberately, with no tick in between, a background tool's permission
  // request lands while `#onTurnEnd` is still suspended awaiting that exact
  // round trip (`#takeFinal`), exactly as in the real incident.
  f.transcriber.final('va bene continua pure');
  f.turns.turnEnd();
  const decision = f.agent.requestPermission({ tool: 'Write', summary: 'scrivere config.json' });
  await f.tick();

  assert.equal(
    d.state,
    'AWAITING_APPROVAL',
    'the non-stop resume must not clobber a permission request that arrived during its own pause',
  );

  // The user now answers the real approval question.
  f.turns.speechStart();
  f.transcriber.final('si vai');
  f.turns.turnEnd();
  await f.tick();

  assert.equal(await decision, true, "the user's actual answer must be processed as approval, not lost");
  assert.deepEqual(
    f.agent.sent,
    ['scrivi il file di configurazione'],
    'the answer must not be misrouted as a fresh follow-up question',
  );
  assert.ok(
    !f.voice.spoken.some((s) => /lascio stare/i.test(s)),
    'the approval timeout must never fire once the user actually answered',
  );

  // The interrupted answer resumes and finishes normally: the barge-in pause
  // this approval arrived inside of is not left stranding `#run`'s loop. Once
  // it does, the earlier non-stop recapture ("va bene continua pure"), queued
  // behind it the whole time, is dispatched as the follow-up it always was.
  f.agent.emitDone();
  await f.tick();
  assert.equal(d.state, 'THINKING', 'the queued follow-up is dispatched once the answer finishes');
  assert.ok(
    f.voice.spoken.includes('Va bene, lo scrivo subito.'),
    'the interrupted answer sentence is actually spoken, not swallowed by the stuck pause',
  );
  assert.deepEqual(
    f.agent.sent,
    ['scrivi il file di configurazione', 'va bene continua pure'],
    "the recapture queued behind the approval is not lost either — it is not the user's approval answer",
  );

  await d.stop();
});

test('a genuine stop flushes, interrupts, and reports what was actually heard', async () => {
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

  assert.equal(f.audioOut.flushes, 1, 'playback must be silenced instantly, on onset alone');
  assert.equal(f.agent.interrupts, 0, 'nothing is cancelled before the recapture even finishes');
  assert.equal(f.voice.aborts, 1, 'the TTS stream must be aborted immediately');
  assert.equal(director.state, 'HEARING');

  f.transcriber.final('basta');
  f.turns.turnEnd();
  await f.tick();
  assert.equal(f.agent.interrupts, 1, 'interrupt(), never abort()');
  assert.equal(director.state, 'LISTENING');

  // The note is carried onto the NEXT question, not the stop word itself —
  // the stop word is never dispatched as a turn at all.
  f.turns.speechStart();
  f.transcriber.final('raccontamene un altra');
  f.turns.turnEnd();
  await f.tick();
  assert.ok(f.agent.interruptionNote, 'Claude must be told it was cut off');
  assert.match(f.agent.interruptionNote!.spokenSoFar, /Cera una volta/);
  assert.equal(f.agent.interruptionNote!.userSaid, 'raccontamene un altra');

  await director.stop();
});

test('the turn detector is told when the device is actually playing self-play audio', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();

  f.audioOut.playing = false;
  f.audioIn.frame();
  assert.equal(
    f.turns.pushed.at(-1)!.selfPlayActive,
    false,
    'nothing is playing yet, so this frame cannot be an echo of the Director',
  );

  f.audioOut.playing = true;
  f.audioIn.frame();
  assert.equal(
    f.turns.pushed.at(-1)!.selfPlayActive,
    true,
    'the device is rendering audio, so the detector must raise its guard against echo',
  );

  await director.stop();
});

test('a barge-in whose recapture yields nothing resumes the answer, and does not haunt the next turn', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();

  f.turns.speechStart();
  f.transcriber.final('lancia la ricerca su linkedin');
  f.turns.turnEnd();
  await f.tick();
  f.agent.emitText('Ti lancio la ricerca su LinkedIn.');
  await f.tick();
  assert.equal(director.state, 'SPEAKING');

  // The onset fires, but what got captured over it — an echo, a stray sound —
  // transcribes to nothing. Not a stop command, so the running turn is left
  // exactly as untouched as any other non-stop follow-up.
  f.audioOut.pendingMs = f.audioOut.enqueuedMs / 2;
  f.turns.speechStart();
  await f.tick();
  f.transcriber.final('');
  f.turns.turnEnd();
  await f.tick();

  assert.ok(
    !f.voice.spoken.some((line) => line.includes('non ho capito')),
    'an empty recapture that is not a stop command is not a cancellation to apologise for',
  );
  assert.equal(f.agent.interrupts, 0, 'nothing was cancelled');

  f.agent.emitDone();
  await f.tick();
  assert.equal(director.state, 'LISTENING');

  // A follow-up that never happened must not attach itself to whatever is said next.
  f.turns.speechStart();
  f.transcriber.final('che ore sono');
  f.turns.turnEnd();
  await f.tick();
  assert.equal(
    f.agent.interruptionNote,
    undefined,
    'this turn never interrupted anything; it must not be told that it did',
  );

  await director.stop();
});

test('a sentence the barge-in flushed away unheard is spoken again on resume', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();

  f.turns.speechStart();
  f.transcriber.final('raccontami una storia');
  f.turns.turnEnd();
  await f.tick();

  // The first sentence is enqueued — `#waitForRoom` lets the Director run up to
  // PLAYBACK_HIGH_WATER_MS ahead of the device, so on any real mid-answer
  // barge-in there is audio sitting in the queue that the user has not heard.
  f.agent.emitText('Prima frase.');
  await f.tick();
  assert.equal(director.state, 'SPEAKING');

  // Nothing at all has actually reached the speaker yet: every enqueued frame is
  // still pending, so `flush()` reports heardMs = 0 and discards the lot.
  f.audioOut.pendingMs = f.audioOut.enqueuedMs;
  f.turns.speechStart();
  await f.tick();
  f.transcriber.final('ah ok capito');
  f.turns.turnEnd();
  await f.tick();

  assert.equal(f.agent.interrupts, 0, 'a non-stop follow-up does not cancel the turn');

  f.agent.emitText('Seconda frase.');
  f.agent.emitDone();
  await f.tick();

  assert.equal(
    f.voice.spoken.filter((line) => line === 'Prima frase.').length,
    2,
    'the user heard none of the first sentence, so resuming must say it again',
  );
  assert.ok(f.voice.spoken.includes('Seconda frase.'), 'the rest of the answer still follows');

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
  f.transcriber.final('basta');
  f.turns.turnEnd();
  await f.tick();
  assert.equal(director.state, 'LISTENING');

  f.turns.speechStart();
  f.transcriber.final('raccontamene un altra');
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
  f.transcriber.final('basta');
  f.turns.turnEnd();
  await f.tick();
  assert.equal(director.state, 'LISTENING');

  f.turns.speechStart();
  f.transcriber.final('raccontamene un altra');
  f.turns.turnEnd();
  await f.tick();
  const firstHeard = f.agent.interruptionNote!.spokenSoFar;
  assert.ok(!firstHeard.includes('castello'), 'the first measurement must not leak into the second');

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
  f.transcriber.final('basta');
  f.turns.turnEnd();
  await f.tick();
  assert.equal(director.state, 'LISTENING');

  f.turns.speechStart();
  f.transcriber.final('e poi?');
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

test('a progress line already speaking is cut off by the answer, not left to overlap', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();

  f.turns.speechStart();
  f.transcriber.final('cerca sul web il meteo');
  f.turns.turnEnd();
  await f.tick();
  f.agent.emitTool('WebSearch', 'start');
  await f.tick();

  // The progress line starts speaking, and the first sentence lands while it is
  // still going. Cancelling only the timer leaves the two talking over each other.
  f.advance(3000);
  f.agent.emitText('A Valenza ci sono venti gradi.');
  await f.tick();

  assert.ok(f.voice.aborts > 0, 'the narration must be silenced, not merely un-scheduled');
  assert.ok(f.voice.spoken.includes('A Valenza ci sono venti gradi.'));

  await director.stop();
});

test('a long tool call is narrated, and stops when the tool ends', async () => {
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();
  f.turns.speechStart();
  f.transcriber.final('cerca il napoli');
  f.turns.turnEnd();
  await f.tick();
  f.agent.emitText('Aspetta, controllo.');
  await f.tick();
  f.agent.emitTool('WebSearch', 'start');
  await f.tick();

  // f.voice.spoken holds the answer's sentences too, so the narration is
  // counted by what only a progress line for this tool can say.
  const narration = (): string[] => f.voice.spoken.filter((s) => /cercando/i.test(s));

  f.advance(3000);
  await f.tick();
  assert.equal(narration().length, 1, 'it says it is still working');

  f.agent.emitTool('WebSearch', 'end');
  await f.tick();
  f.advance(9000);
  await f.tick();
  assert.equal(narration().length, 1, 'and stops once the tool is done');

  await d.stop();
});

test('narration survives one tool of a parallel pair finishing before the other', async () => {
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();
  f.turns.speechStart();
  f.transcriber.final('cerca il napoli e leggi la pagina');
  f.turns.turnEnd();
  await f.tick();
  f.agent.emitText('Aspetta, controllo.');
  await f.tick();

  // Claude routinely fires tools in parallel: session.ts brackets each with
  // its own start/end, one bracket per content-block index. A fast Read
  // finishing alongside a slow WebSearch is exactly the case a lone end per
  // tool gets wrong.
  f.agent.emitTool('Read', 'start');
  f.agent.emitTool('WebSearch', 'start');
  await f.tick();

  const narration = (): string[] => f.voice.spoken.filter((s) => s !== 'Aspetta, controllo.');

  f.advance(3000);
  await f.tick();
  assert.equal(narration().length, 1, 'it narrates while both tools are running');

  // The fast one finishes; the slow one has not. Its end must not read as
  // "the tool call is over" while a sibling call is still outstanding.
  f.agent.emitTool('Read', 'end');
  await f.tick();
  f.advance(3000);
  await f.tick();
  assert.equal(narration().length, 2, 'it keeps talking while WebSearch is still running');

  f.agent.emitTool('WebSearch', 'end');
  await f.tick();
  f.advance(9000);
  await f.tick();
  assert.equal(narration().length, 2, 'and only stops once the last one ends');

  await d.stop();
});

test('a line spoken mid-answer does not distort what the user heard', async () => {
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();
  f.turns.speechStart();
  f.transcriber.final('domanda');
  f.turns.turnEnd();
  await f.tick();

  f.agent.emitText('Prima frase. Seconda frase.');
  await f.tick();
  // The only thing that speaks while an answer is already running: a tool
  // starts behind the sentence just spoken, and the wait is narrated.
  f.agent.emitTool('WebSearch', 'start');
  await f.tick();
  f.advance(3000);
  await f.tick();
  f.audioOut.pendingMs = 0; // everything was rendered

  f.turns.speechStart();
  await f.tick();
  f.transcriber.final('basta');
  f.turns.turnEnd();
  await f.tick();
  assert.equal(d.state, 'LISTENING');

  f.turns.speechStart();
  f.transcriber.final('e poi?');
  f.turns.turnEnd();
  await f.tick();
  // Without aside accounting the answer looks longer than it was and the
  // prefix comes back truncated, telling Claude the user missed words they heard.
  assert.equal(f.agent.interruptionNote!.spokenSoFar, 'Prima frase. Seconda frase.');

  await d.stop();
});

test('a line spoken between two sentences is not heard answer', async () => {
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();
  f.turns.speechStart();
  f.transcriber.final('cerca il napoli');
  f.turns.turnEnd();
  await f.tick();

  f.agent.emitText('Prima frase.');
  await f.tick();
  f.agent.emitTool('WebSearch', 'start');
  await f.tick();
  f.advance(3000);
  await f.tick();
  f.agent.emitTool('WebSearch', 'end');
  await f.tick();

  // The answer resumes after the narration, so the aside sits INSIDE the
  // answer's stretch of the device timeline — the case #answerFromMs cannot
  // see, because it is already behind it.
  const beforeTail = f.audioOut.enqueuedMs;
  f.agent.emitText('Il Napoli gioca domenica sera contro la Roma allo stadio Maradona.');
  await f.tick();
  // The user cut in the moment the second sentence began: they heard the first
  // one and the narration, and not one word of the second.
  f.audioOut.pendingMs = f.audioOut.enqueuedMs - beforeTail;

  f.turns.speechStart();
  await f.tick();
  f.transcriber.final('basta');
  f.turns.turnEnd();
  await f.tick();
  assert.equal(d.state, 'LISTENING');

  f.turns.speechStart();
  f.transcriber.final('e poi?');
  f.turns.turnEnd();
  await f.tick();

  const heard = f.agent.interruptionNote!.spokenSoFar;
  assert.equal(heard, 'Prima frase.', 'the first sentence, and nothing after it');
  assert.ok(
    !heard.includes('Napoli'),
    'counting the narration as answer makes the note claim words the user never got',
  );

  await d.stop();
});

test('a barge-in mid-progress-line keeps the answer already heard', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();

  f.turns.speechStart();
  f.transcriber.final('quando gioca il napoli');
  f.turns.turnEnd();
  await f.tick();
  f.agent.emitText('Aspetta, controllo.');
  await f.tick();
  assert.equal(director.state, 'SPEAKING');

  // The answer has fully rendered before the tool starts; then the wait is
  // narrated by a progress line enqueued while the tool is still running.
  const answerEndMs = f.audioOut.enqueuedMs;
  f.agent.emitTool('WebSearch', 'start');
  await f.tick();
  f.advance(3000);
  await f.tick();
  const asideEndMs = f.audioOut.enqueuedMs;

  // The user cuts in during the line's first word: the whole line is still
  // queued, so flush() discards it and reports only the answer as heard.
  f.audioOut.pendingMs = asideEndMs - answerEndMs;
  f.turns.speechStart();
  await f.tick();
  f.transcriber.final('basta');
  f.turns.turnEnd();
  await f.tick();
  assert.equal(director.state, 'LISTENING');

  f.turns.speechStart();
  f.transcriber.final('e poi?');
  f.turns.turnEnd();
  await f.tick();

  assert.equal(
    f.agent.interruptionNote!.spokenSoFar,
    'Aspetta, controllo.',
    'the answer that was actually heard must survive, not be reported as nothing',
  );

  await director.stop();
});

test('a barge-in that discards pre-answer narration still tracks the answer after it', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();

  f.turns.speechStart();
  f.transcriber.final('quando gioca il napoli');
  f.turns.turnEnd();
  await f.tick();

  // A progress line is enqueued BEFORE the answer, so the answer's own first
  // frame is anchored well into the device timeline (`#answerFromMs`).
  f.agent.emitTool('WebSearch', 'start');
  await f.tick();
  f.advance(3000);
  await f.tick();
  f.agent.emitTool('WebSearch', 'end');
  await f.tick();
  f.agent.emitText('Ok.');
  await f.tick();

  // The user cuts in while that narration is still mostly queued: flush()
  // throws it away and reports a rendered total far SHORT of the point the
  // answer was anchored at. If the anchor is not brought back with it, the
  // answer's own length reads as negative from here on and every sentence
  // after this pause is silently dropped from what the note can report.
  f.audioOut.pendingMs = f.audioOut.enqueuedMs - 500;
  f.turns.speechStart();
  await f.tick();
  f.transcriber.final('ah ok');
  f.turns.turnEnd();
  await f.tick();

  f.agent.emitText('Seconda frase.');
  await f.tick();

  // Now a genuine stop, with everything rendered.
  f.audioOut.pendingMs = 0;
  f.turns.speechStart();
  await f.tick();
  f.transcriber.final('basta');
  f.turns.turnEnd();
  await f.tick();

  f.turns.speechStart();
  f.transcriber.final('e poi?');
  f.turns.turnEnd();
  await f.tick();

  assert.equal(
    f.agent.interruptionNote!.spokenSoFar,
    'Ok. Seconda frase.',
    'everything played after the first pause must still be reported as heard',
  );

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

test('nothing is spoken into the wait for the first token', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();

  f.turns.speechStart();
  f.transcriber.final('che ore sono');
  f.turns.turnEnd();
  await f.tick();

  // The wait for the first token used to be covered by a filler line ("un attimo
  // che guardo"). It fired on nearly every turn — a long first sentence trails
  // its first token by more than any timer — and being talked over is worse than
  // a moment of silence. The Director says nothing it was not asked to say.
  f.advance(10_000);
  await f.tick();
  assert.deepEqual(f.voice.spoken, [], 'silence while thinking, always');

  await director.stop();
});

test('a slow first token is still silent once the answer arrives', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();

  f.turns.speechStart();
  f.transcriber.final('che ore sono');
  f.turns.turnEnd();
  await f.tick();

  f.advance(10_000);
  await f.tick();
  f.agent.emitText('Sono le tre.');
  await f.tick();

  assert.deepEqual(
    f.voice.spoken,
    ['Sono le tre.'],
    'the answer is the first thing the user hears from the Director',
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

test('an empty transcript during an approval denies out loud, not in silence', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();

  f.turns.speechStart();
  f.transcriber.final('scrivi il file');
  f.turns.turnEnd();
  await f.tick();

  const decision = f.agent.requestPermission({ tool: 'Write', summary: 'scrivere su session.ts' });
  await f.tick();

  // Whisper heard something but it cleaned down to nothing — not the timeout
  // path (no timer fires), and not the hallucinated-noise path either: the
  // user actually spoke and expects to be told what happened.
  f.transcriber.final('');
  f.turns.turnEnd();
  await f.tick();

  assert.equal(await decision, false, 'fail closed, same as any other unclear answer');
  assert.deepEqual(f.agent.sent, ['scrivi il file'], 'nothing to redispatch — the text was empty');
  assert.ok(
    f.voice.spoken.some((s) => /non ho capito/i.test(s)),
    'a denial with zero spoken feedback is indistinguishable from being ignored',
  );

  await director.stop();
});

test('a full-sentence approval reply survives the round trip, not just a bare sì', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);
  await director.start();

  f.turns.speechStart();
  f.transcriber.final('cerca lavori web3 developer su linkedin');
  f.turns.turnEnd();
  await f.tick();

  const decision = f.agent.requestPermission({ tool: 'WebSearch', summary: 'cercare su LinkedIn' });
  await f.tick();
  assert.equal(director.state, 'AWAITING_APPROVAL');

  // Advance past whisper's own worst-case ceiling (REQUEST_TIMEOUT_MS,
  // src/stt/transcriber.ts — a single generous attempt at the final
  // transcription), not a fraction of approvalTimeoutMs: that constant is
  // what this whole fix exists to outlast, so parameterising the advance on
  // it (e.g. `approvalTimeoutMs - 10`) would let this test pass no matter
  // what approvalTimeoutMs is set to. This is deliberately still short of
  // approvalTimeoutMs (20000ms) — see the invariant test in config.test.ts
  // that keeps the two constants from drifting back together.
  assert.ok(
    REQUEST_TIMEOUT_MS + 1000 < config.director.approvalTimeoutMs,
    'the advance below must land after REQUEST_TIMEOUT_MS but still inside the budget',
  );
  f.advance(REQUEST_TIMEOUT_MS + 1000);
  f.turns.speechStart();
  f.transcriber.final('sì cerca web3 developer jobs');
  f.turns.turnEnd();
  await f.tick();

  assert.equal(await decision, false, "a full sentence is 'unclear', not consent — fail closed");
  assert.deepEqual(
    f.agent.sent,
    ['cerca lavori web3 developer su linkedin', 'sì cerca web3 developer jobs'],
    'an unclear reply arriving well inside the budget must still be redispatched, not abandoned',
  );
  assert.ok(
    !f.voice.spoken.some((s) => /lascio stare/i.test(s)),
    'a reply that arrived in time must never be treated as a give-up',
  );

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

// -------------------------------------------------------------- diagnostics

test('diagnostics stay silent unless a debug hook is supplied', async () => {
  const f = makeFakes(config);
  const director = new Director(f.deps);

  // No `debug` dep was injected — the Director must never reach for a bare
  // console call of its own, or this is a log again, not a voice app.
  const originalLog = console.log;
  const originalError = console.error;
  let calls = 0;
  console.log = () => {
    calls++;
  };
  console.error = () => {
    calls++;
  };
  try {
    await director.start();
    f.turns.speechStart();
    f.transcriber.final('che ore sono');
    f.turns.turnEnd();
    await f.tick();
    f.agent.emitText('Sono le tre.');
    await f.tick();
    f.agent.emitDone();
    await f.tick();
    await director.stop();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(calls, 0, 'a quiet default: this is a voice app, not a log');
});

test('a debug hook receives the turn trace: transcript, state, tool, and the barge-in accounting', async () => {
  const lines: string[] = [];
  const f = makeFakes(config, { debug: (message: string) => lines.push(message) });
  const director = new Director(f.deps);
  await director.start();

  f.turns.speechStart();
  f.transcriber.final('cerca il meteo');
  f.turns.turnEnd();
  await f.tick();
  f.agent.emitText('Aspetta, controllo.');
  await f.tick();
  f.agent.emitTool('WebSearch', 'start');
  await f.tick();
  f.agent.emitTool('WebSearch', 'end');
  await f.tick();
  f.agent.emitText('A Valenza ci sono venti gradi.');
  await f.tick();
  assert.equal(director.state, 'SPEAKING');

  // The barge-in that Task 7 needs the numbers from.
  f.turns.speechStart();
  await f.tick();

  await director.stop();

  assert.ok(
    lines.includes(`turn: transcript=${JSON.stringify('cerca il meteo')}`),
    'the turn boundary names what was said',
  );
  assert.ok(
    lines.includes('state: LISTENING -> HEARING'),
    'state transitions are traced by name, not just the fact that one happened',
  );
  assert.ok(lines.includes('tool: start WebSearch'), 'tool names are traced, start...');
  assert.ok(lines.includes('tool: end WebSearch'), '...and end');

  const bargeIn = lines.find((l) => l.startsWith('barge-in:'));
  assert.ok(bargeIn, 'the barge-in accounting line exists');
  for (const field of ['enqueuedMs=', 'answerFromMs=', 'asideMs=', 'heardMs=', 'prefix=']) {
    assert.ok(bargeIn!.includes(field), `barge-in line is missing ${field}`);
  }
});

test('muting stops a frame from ever reaching the turn detector', async () => {
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();

  d.setMuted(true);
  assert.equal(d.muted, true);
  f.audioIn.frame();
  assert.equal(f.turns.pushed.length, 0, 'a muted room produces no onset at all');

  d.setMuted(false);
  f.audioIn.frame();
  assert.equal(f.turns.pushed.length, 1, 'unmuting resumes normal capture');

  await d.stop();
});

test('muting mid-utterance cancels it instead of waiting it out', async () => {
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();

  f.turns.speechStart();
  assert.equal(d.state, 'HEARING');
  f.audioIn.frame();
  assert.equal(f.transcriber.current!.pushed.length, 1);

  d.setMuted(true);
  assert.equal(d.state, 'LISTENING', 'muting instantly cancels the in-progress utterance');
  f.audioIn.frame();
  assert.equal(
    f.transcriber.current!.pushed.length,
    1,
    'no further frames are captured once muted',
  );

  await d.stop();
});

test('a turn whose stream never produces another event is abandoned, not left silent forever', async () => {
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();

  f.turns.speechStart();
  f.transcriber.final('cerca qualcosa di impossibile');
  f.turns.turnEnd();
  await f.tick();
  assert.equal(d.state, 'THINKING');

  // FakeAgentSession.send() blocks forever here: no text, no tool, no done —
  // exactly the genuinely hung network call the watchdog exists for.
  f.advance(config.director.turnTimeoutMs + 10);
  await f.tick();

  assert.equal(d.state, 'LISTENING', 'the turn is abandoned rather than left hanging');
  assert.ok(
    f.voice.spoken.some((s) => /qualcosa è andato storto/i.test(s)),
    'the user is told, not left in silence',
  );
  assert.equal(f.agent.interrupts, 1, 'the agent still working on it is told to stop');

  await d.stop();
});

/**
 * A Voice whose generator never looks at `signal` at all — not even once —
 * unlike every other fake in this file (FakeVoice, BlockingVoice), which all
 * check it somewhere. Exists for exactly one test: proving `#play()` does not
 * depend on a Voice noticing its own abort to return promptly.
 */
class IgnoresAbortVoice implements Voice {
  readonly spoken: string[] = [];

  async *synthesize(text: AsyncIterable<string>): AsyncIterable<AudioFrame> {
    for await (const sentence of text) {
      this.spoken.push(sentence);
      yield new Int16Array(10).fill(1000);
      // Never resolves, never checks `signal` — the outstanding `.next()`
      // call this suspends inside is exactly the one `pullOrAbort` (director.ts)
      // deliberately abandons on abort, and per the async-generator spec is
      // also exactly what a `.return()` call queues behind. Awaiting
      // `.return()` in `#play()`'s `finally` block used to wait on this.
      await new Promise<void>(() => {});
    }
  }
}

test('a turn is not wedged by a Voice generator that never notices its own abort', async () => {
  // Regression test for code review finding #2 (2026-09-27, round 3):
  // `#play()`'s `finally` block used to `await iterator.return?.()`. Per the
  // async-generator spec, `.return()` queued behind an outstanding `.next()`
  // does not settle until that `.next()` does — and `pullOrAbort` deliberately
  // abandons its own `.next()` call the instant abort wins the race, which
  // means every barge-in enters `finally` with a `.next()` still pending.
  // Against a Voice that never notices the abort itself (this one), that
  // pending `.next()` never settles, so the old code blocked `#play()`'s own
  // return on it — and because a barge-in's resume is driven by the SAME
  // `#run()` loop iteration that called the stuck `#play()`, the whole turn
  // never resumed: not until the unrelated 45s turn timeout gave up on it.
  const voice = new IgnoresAbortVoice();
  const f = makeFakes(config, { voice });
  const d = new Director(f.deps);
  await d.start();

  f.turns.speechStart();
  f.transcriber.final('raccontami una storia');
  f.turns.turnEnd();
  await f.tick();
  f.agent.emitText('Prima frase.');
  await f.tick();
  assert.equal(d.state, 'SPEAKING');
  assert.deepEqual(voice.spoken, ['Prima frase.']);

  // Onset mid-sentence: `#play()`'s own AbortController fires, but this
  // Voice's generator is permanently suspended and will never notice.
  f.turns.speechStart();
  await f.tick();
  assert.equal(d.state, 'HEARING', 'the mute is unconditional and instant, regardless of the Voice');

  // Not a stop command — an ordinary follow-up said over the mute. The
  // single frame this Voice managed to yield before hanging is nowhere near
  // 'Prima frase.'s estimated 840ms, so nothing was confirmed and the resumed
  // `#run()` loop must feed it to a FRESH `synthesize()` call, same as before
  // the mute. If `#play()` were still stuck awaiting `iterator.return?.()`
  // (Bug B), that fresh call would never happen — no second entry here, ever,
  // short of the unrelated 45s turn timeout tearing the whole turn down.
  f.transcriber.final('no aspetta');
  f.turns.turnEnd();
  await f.tick();
  assert.equal(f.agent.interrupts, 0, 'a non-stop recapture must not have been treated as a cancellation');
  assert.deepEqual(
    voice.spoken,
    ['Prima frase.', 'Prima frase.'],
    'the turn must have actually resumed and fed the sentence to a new synthesize() call',
  );

  await d.stop();
});

test('repeated tool approvals do not grant the turn a fresh 45s window each time', async () => {
  // Regression for a real bug (spec: 2026-09-27, a LinkedIn search kept
  // re-approving Bash calls for ~20 minutes before the user gave up): each
  // #onPermission/#answer round trip used to re-arm the turn timer with a
  // brand-new turnTimeoutMs window instead of the turn's original absolute
  // deadline, so a turn that racks up enough sequential approvals could run
  // arbitrarily long — defeating the "hard ceiling" the watchdog exists for.
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();

  f.turns.speechStart();
  f.transcriber.final('cerca lavori web3 developer su linkedin');
  f.turns.turnEnd();
  await f.tick();

  // Each round spends real "thinking" time (which DOES count against the
  // budget) followed by a brief approval pause (which, correctly, does not
  // — see #turnDeadline's comment). Across 5 rounds this consumes most of
  // turnTimeoutMs (45000ms) via legitimate running time, not via the pause.
  const rounds = 5;
  const perRoundThink = 8000;
  const perRoundPause = 2000;
  for (let i = 0; i < rounds; i++) {
    f.advance(perRoundThink);
    const decision = f.agent.requestPermission({ tool: 'Bash', summary: `eseguire il comando ${i}` });
    await f.tick();
    assert.equal(d.state, 'AWAITING_APPROVAL');
    f.advance(perRoundPause);
    f.turns.speechStart();
    f.transcriber.final('sì vai');
    f.turns.turnEnd();
    await f.tick();
    assert.equal(await decision, true);
  }

  // 5 * 8000 = 40000ms of real thinking time has elapsed against the
  // original 45000ms deadline (the 5 * 2000ms of pause time does not
  // count). Only ~5000ms of true budget remains. If each approval had
  // wrongly re-armed a fresh 45000ms window instead of the remaining time
  // (the bug this test guards against), this small advance would do
  // nothing and the turn would still be alive; with the fix, the original
  // deadline holds and the turn is abandoned.
  f.advance(config.director.turnTimeoutMs - rounds * perRoundThink + 10);
  await f.tick();

  assert.equal(
    d.state,
    'LISTENING',
    'the turn is abandoned at its original deadline, not given a fresh window per approval',
  );

  await d.stop();
});

test('a short reply in another language does not switch the conversation language', async () => {
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();

  f.turns.speechStart();
  // 'ok' is 1 word — well under MIN_WORDS_FOR_LANGUAGE_SWITCH — so even a
  // confident 'en' detection here must not flip #language away from 'it'.
  f.transcriber.final('ok', 'en', 0.95);
  f.turns.turnEnd();
  await f.tick();
  assert.equal(d.state, 'THINKING');

  f.agent.emitText('Va bene.');
  f.agent.emitDone();
  await f.tick();

  assert.deepEqual(
    f.voice.languages,
    ['it'],
    'a short, ambiguous utterance must not flip the whole conversation\'s language',
  );

  await d.stop();
});

test('a substantial reply in another language switches the conversation language', async () => {
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();

  f.turns.speechStart();
  f.transcriber.final('actually can you tell me what time it is right now', 'en', 0.9);
  f.turns.turnEnd();
  await f.tick();
  assert.equal(d.state, 'THINKING');

  f.agent.emitText('It is three o\'clock.');
  f.agent.emitDone();
  await f.tick();

  assert.deepEqual(
    f.voice.languages,
    ['en'],
    'a long, confident utterance in a new language must switch the reply language',
  );

  await d.stop();
});

test('a Director-spoken line (#say) uses the current sticky language, not always Italian', async () => {
  // Bug fix: #say() (approval questions, progress lines, apologies — every
  // line the Director writes itself, as opposed to the agent's own answer
  // text spoken via #play()) called voice.synthesize() with no language
  // argument at all, so it always fell back to the configured default
  // (Italian) even once #language had switched sticky to English mid-
  // conversation. #play() already read #language correctly; #say() must be
  // consistent with it.
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();

  f.turns.speechStart();
  f.transcriber.final('actually can you tell me what time it is right now', 'en', 0.9);
  f.turns.turnEnd();
  await f.tick();
  f.agent.emitText('It is three o\'clock.');
  f.agent.emitDone();
  await f.tick();
  assert.equal(d.state, 'LISTENING');

  // A follow-up write tool call triggers a Director-spoken approval question
  // (#say), after the conversation has already switched to English.
  f.turns.speechStart();
  f.transcriber.final('write it down', 'en', 0.9);
  f.turns.turnEnd();
  await f.tick();

  void f.agent.requestPermission({ tool: 'Write', summary: 'write to notes.txt' });
  await f.tick();
  assert.equal(d.state, 'AWAITING_APPROVAL');

  assert.equal(
    f.voice.languages.at(-1),
    'en',
    "the Director's own spoken approval question must follow the sticky language, not default to Italian",
  );

  f.advance(config.director.approvalTimeoutMs + 10);
  await f.tick();
  await d.stop();
});

test('a low-confidence detection does not switch the conversation language, even with plenty of words', async () => {
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();

  f.turns.speechStart();
  // Long enough to clear the word-count gate, but whisper itself is not sure
  // — this must not be enough on its own to switch.
  f.transcriber.final('actually can you tell me what time it is right now', 'en', 0.2);
  f.turns.turnEnd();
  await f.tick();
  assert.equal(d.state, 'THINKING');

  f.agent.emitText('Sono le tre.');
  f.agent.emitDone();
  await f.tick();

  assert.deepEqual(
    f.voice.languages,
    ['it'],
    'a low-confidence guess must not switch the language just because the utterance was long',
  );

  await d.stop();
});

test('the language switch persists across a later, unrelated turn and can switch back', async () => {
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();

  f.turns.speechStart();
  f.transcriber.final('actually can you tell me what time it is right now', 'en', 0.9);
  f.turns.turnEnd();
  await f.tick();
  f.agent.emitText('It is three o\'clock.');
  f.agent.emitDone();
  await f.tick();
  assert.equal(d.state, 'LISTENING');

  // A short follow-up must keep speaking English — the switch is sticky, not
  // re-evaluated word-by-word on every subsequent short reply.
  f.turns.speechStart();
  f.transcriber.final('thanks', 'en', 0.9);
  f.turns.turnEnd();
  await f.tick();
  f.agent.emitText('You\'re welcome.');
  f.agent.emitDone();
  await f.tick();
  assert.equal(d.state, 'LISTENING');

  // Switching back to Italian requires the same bar as switching away from it.
  f.turns.speechStart();
  f.transcriber.final('anzi dimmi che ore sono adesso per favore', 'it', 0.9);
  f.turns.turnEnd();
  await f.tick();
  f.agent.emitText('Sono le tre.');
  f.agent.emitDone();
  await f.tick();

  assert.deepEqual(
    f.voice.languages,
    ['en', 'en', 'it'],
    'the sticky language switches back once a substantial, confident Italian utterance arrives',
  );

  await d.stop();
});

test('an unsupported detected language code never switches the conversation language', async () => {
  // Bug fix, 2026-09-27: without an allow-list, ANY code whisper-server
  // reports — including a rare/misdetected one on a noisy clip that happens
  // to clear both the word-count and confidence gates — would get accepted,
  // and the switch is STICKY: Cartesia's sonic-3 voice would then reject
  // every subsequent synthesize() call using it, breaking every following
  // turn. 'fr' clears both thresholds below on purpose, to prove the
  // allow-list is what stops it, not word count or confidence.
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();

  f.turns.speechStart();
  f.transcriber.final('actually can you tell me what time it is right now', 'fr', 0.95);
  f.turns.turnEnd();
  await f.tick();
  assert.equal(d.state, 'THINKING');

  f.agent.emitText('Sono le tre.');
  f.agent.emitDone();
  await f.tick();

  assert.deepEqual(
    f.voice.languages,
    ['it'],
    'a detected language outside the supported allow-list must never become the sticky language',
  );

  await d.stop();
});

/**
 * Blocks specifically on the DIDNT_CATCH line ("non ho capito") so a test can
 * land a second, unrelated approval request in the exact window #answer's own
 * doc comment says is possible: mid-`await this.#say(DIDNT_CATCH)`. Every
 * other sentence (the approval questions themselves) resolves immediately, the
 * same as FakeVoice, so #onPermission's own spoken question is never stuck.
 */
class BlockingVoice implements Voice {
  readonly languages: (string | undefined)[] = [];
  readonly spoken: string[] = [];
  #release: (() => void) | undefined;

  release(): void {
    this.#release?.();
    this.#release = undefined;
  }

  async *synthesize(
    text: AsyncIterable<string>,
    signal: AbortSignal,
    language?: string,
  ): AsyncIterable<AudioFrame> {
    this.languages.push(language);
    for await (const sentence of text) {
      this.spoken.push(sentence);
      if (sentence.includes('non ho capito')) {
        await new Promise<void>((resolve) => {
          this.#release = resolve;
        });
      }
      if (signal.aborted) return;
      yield new Int16Array(10).fill(1000);
    }
  }
}

test('a second approval arriving mid-DIDNT_CATCH is not silently destroyed by the stale one', async () => {
  // Bug fix, 2026-09-27: `approval` is captured locally at the top of
  // #answer(). After `await this.#say(DIDNT_CATCH)`, the old code went on to
  // call `this.#resolveApproval(...)` and `this.#setState(approval.from)`
  // unconditionally — reading/using whatever is CURRENT, not what was
  // captured — even though a second, unrelated permission request can land
  // during that very await (#onPermission's own doc comment says as much)
  // without bumping #turnId, so the existing turnId guard does not catch it.
  const voice = new BlockingVoice();
  const f = makeFakes(config, { voice });
  const director = new Director(f.deps);
  await director.start();

  f.turns.speechStart();
  f.transcriber.final('scrivi il file');
  f.turns.turnEnd();
  await f.tick();

  const decision1 = f.agent.requestPermission({ tool: 'Write', summary: 'scrivere su session.ts' });
  await f.tick();
  assert.equal(director.state, 'AWAITING_APPROVAL');

  // Empty transcript: 'unclear' with nothing to redispatch, so #answer awaits
  // #say(DIDNT_CATCH) before resolving anything — the window this bug lives in.
  f.transcriber.final('');
  f.turns.turnEnd();
  await f.tick();
  assert.ok(
    voice.spoken.some((s) => s.includes('non ho capito')),
    'the DIDNT_CATCH line must be mid-synthesis, not finished, at this point',
  );

  // A second, unrelated permission request lands while the first is still
  // stuck saying DIDNT_CATCH — exactly the race #onPermission's own doc
  // comment documents as possible.
  const decision2 = f.agent.requestPermission({ tool: 'Read', summary: 'leggere un altro file' });
  await f.tick();
  assert.equal(director.state, 'AWAITING_APPROVAL', 'the second approval is now the one in flight');
  assert.equal(await decision1, false, 'the first approval is still correctly denied by #onPermission itself');

  // Unblock the DIDNT_CATCH line; the stale #answer call resumes here.
  voice.release();
  await f.tick();

  // The second approval must still be answerable — not silently destroyed by
  // the stale #answer call resuming behind it.
  f.transcriber.final('sì');
  f.turns.turnEnd();
  await f.tick();

  assert.equal(await decision2, true, 'the second, still-legitimate approval must not be silently denied');

  await director.stop();
});

test('an approval abandoned by redispatch does not inflate a later turn\'s deadline', async () => {
  // Bug fix, 2026-09-27: `#approvalPauseStart` was cleared in exactly one
  // place — the success (yes/no) tail of `#answer()` — and every other exit
  // from an approval (this test uses the 'unclear' && text redispatch
  // branch) left it set. `#run()` reset every other per-turn field but not
  // this one, so a SECOND, later, completely unrelated turn's own approval
  // saw `#approvalPauseStart` already defined, left it alone (the guard that
  // stops two genuinely concurrent approvals from clobbering each other), and
  // then credited back the time since the FIRST turn's abandoned approval —
  // inflating the second turn's `#turnDeadline` by however long ago that was.
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();

  f.turns.speechStart();
  f.transcriber.final('cerca lavori web3 developer su linkedin');
  f.turns.turnEnd();
  await f.tick();

  // Turn 1's approval is raised, then immediately abandoned via a full,
  // ambiguous reply — the redispatch path that used to leak
  // #approvalPauseStart.
  f.agent.requestPermission({ tool: 'WebSearch', summary: 'cercare su LinkedIn' });
  await f.tick();
  assert.equal(d.state, 'AWAITING_APPROVAL');

  f.turns.speechStart();
  f.transcriber.final('no aspetta in realtà volevo altro');
  f.turns.turnEnd();
  await f.tick();
  assert.equal(
    d.state,
    'THINKING',
    'the ambiguous reply must have been redispatched as a brand-new turn 2',
  );

  // Turn 2 runs for a long time (well inside its own fresh 45s budget) before
  // it, too, needs an approval.
  f.advance(40_000);
  const decision2 = f.agent.requestPermission({ tool: 'Bash', summary: 'eseguire un comando' });
  await f.tick();
  assert.equal(d.state, 'AWAITING_APPROVAL');

  // The user answers turn 2's approval quickly.
  f.advance(2_000);
  f.turns.speechStart();
  f.transcriber.final('sì vai');
  f.turns.turnEnd();
  await f.tick();
  assert.equal(await decision2, true);

  // Correct behaviour: turn 2's deadline is its original 45s window plus the
  // 2s it was actually paused for its own approval — 47s after turn 2 began,
  // i.e. 7s from here. The bug credited back the time since turn 1's
  // approval instead (42s at the point turn 2's approval was answered),
  // pushing the deadline out to ~87s after turn 2 began — nearly 40s of
  // unearned extra budget. Advancing just past the CORRECT deadline must
  // abandon the turn; the buggy version would still have it alive.
  f.advance(5_100);
  await f.tick();

  assert.equal(
    d.state,
    'LISTENING',
    "turn 2 must be abandoned at its own, correct deadline, not kept alive by turn 1's leaked pause start",
  );

  await d.stop();
});

test('an unclear approval answer mid barge-in pause releases the pause instead of leaking it', async () => {
  // Bug fix, 2026-09-27: the yes/no tail of #answer() was patched (round 4)
  // to release a still-open SPEAKING-onset barge-in pause before resuming —
  // otherwise `#run`'s loop, parked on `#bargeInResume`, is never woken. The
  // sibling 'unclear' && text branch, which redispatches instead of resuming,
  // had no such guard: left alone, `#pausedForBargeIn` stays wrongly true for
  // the rest of the session and corrupts later, unrelated turns' own
  // pause/resume bookkeeping.
  const f = makeFakes(config);
  const d = new Director(f.deps);
  await d.start();

  f.turns.speechStart();
  f.transcriber.final('scrivi il file di configurazione');
  f.turns.turnEnd();
  await f.tick();
  f.agent.emitText('Va bene, lo scrivo subito.');
  await f.tick();
  assert.equal(d.state, 'SPEAKING');

  // Onset barge-in: instant mute, recapture starts.
  f.turns.speechStart();
  assert.equal(d.state, 'HEARING');
  await f.tick(); // let #muteForBargeIn's flush settle before the recapture's own final lands

  // A permission request lands while the recapture is still being finalised,
  // exactly as in the sibling (already-fixed) yes/no scenario. The recapture
  // itself resolves to nothing said (a cough, an echo) — deliberately, so it
  // is not queued as a follow-up behind the approval and does not confuse
  // what this test is actually about (the *approval's own answer* being
  // unclear, handled separately below).
  f.transcriber.final('');
  f.turns.turnEnd();
  const decision = f.agent.requestPermission({ tool: 'Write', summary: 'scrivere config.json' });
  await f.tick();
  assert.equal(d.state, 'AWAITING_APPROVAL');

  // But this time the recapture's answer to that approval is a whole,
  // ambiguous sentence, not yes/no — 'unclear' && text, the branch under test.
  f.turns.speechStart();
  f.transcriber.final('no aspetta in realtà volevo un\'altra cosa');
  f.turns.turnEnd();
  await f.tick();

  assert.equal(await decision, false, 'an ambiguous reply denies, same as any other unclear answer');
  assert.deepEqual(
    f.agent.sent,
    ['scrivi il file di configurazione', "no aspetta in realtà volevo un'altra cosa"],
    'the ambiguous reply must be redispatched as its own new turn',
  );
  assert.equal(d.state, 'THINKING', 'turn 2 is now running');

  // Turn 2 finishes normally and the session goes idle.
  f.agent.emitText('Ecco la nuova risposta.');
  f.agent.emitDone();
  await f.tick();
  assert.equal(d.state, 'LISTENING');

  // Turn 3: an ordinary fresh question, dispatched from LISTENING — unaffected
  // either way, since `#onTurnEnd`'s corrupted branch below is only reachable
  // when an utterance BEGAN while THINKING or SPEAKING (`capturingFrom`).
  // This just gets something running to build the decisive race against.
  f.turns.speechStart();
  f.transcriber.final("un'altra domanda del tutto separata");
  f.turns.turnEnd();
  await f.tick();
  assert.equal(d.state, 'THINKING');

  // The decisive check: a fourth, distinct onset begins HERE, while turn 3 is
  // still THINKING (`capturingFrom` records exactly that) — and turn 3 goes
  // on to finish, all the way back to LISTENING, before this onset's own
  // final transcript comes back (`#onTurnEnd`'s round trip through
  // `#takeFinal`). `#onTurnEnd`'s `stillInFlight` computation ORs in
  // `#pausedForBargeIn` precisely to cover a pause still open at that exact
  // moment — if it had leaked true from the earlier redispatch instead of
  // being genuinely open, this combination is wrongly routed through the
  // "still in flight" branch (built for a turn that is actually still
  // running) instead of the plain "finished turn, ordinary new question"
  // path: `#state` gets force-set to 'SPEAKING' with nothing left to ever
  // play or drain the queued utterance, and the follow-up is silently lost
  // for the rest of the session.
  f.turns.speechStart();
  f.agent.emitText('Risposta al turno 3.');
  f.agent.emitDone();
  await f.tick();
  assert.equal(d.state, 'LISTENING', 'turn 3 must have finished while the next onset was still being captured');

  f.transcriber.final('e questa quarta domanda');
  f.turns.turnEnd();
  await f.tick();

  assert.equal(
    d.state,
    'THINKING',
    'a fresh follow-up must be dispatched normally, not wrongly treated as still in flight by a leaked pause',
  );
  assert.deepEqual(f.agent.sent, [
    'scrivi il file di configurazione',
    "no aspetta in realtà volevo un'altra cosa",
    "un'altra domanda del tutto separata",
    'e questa quarta domanda',
  ]);

  await d.stop();
});
