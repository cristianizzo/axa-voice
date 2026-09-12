# Interruption and waiting model — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Talking to it while it works adds to the conversation instead of destroying it; talking over it while it speaks still cuts it off.

**Architecture:** The Director stops treating `THINKING` as interruptible, captures speech in any state, and routes the transcript by state — stop command, queued follow-up, or normal turn. Tool events, already carried by `AgentEvent` and never consumed, become spoken progress. Audio the Director speaks on its own behalf is counted separately from the answer so it cannot corrupt the interruption note.

**Tech Stack:** TypeScript on Node 22.18 type stripping, `node:test`, no build step.

**Spec:** `docs/superpowers/specs/2026-09-12-interruption-model-design.md`

## Global Constraints

- Node >= 22.18, TypeScript run unbuilt. `.ts` import specifiers everywhere.
- `erasableSyntaxOnly`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`.
- Tests: `node:test` + `node:assert/strict`. `npm test` must stay hardware-free, network-free and money-free.
- Everything spoken is Italian. §7 governs: name the action, never a path or an argument.
- `npm run typecheck` and `npm test` pass at the end of every task.
- Never widen an interface to make a test easier; the fakes model the real contract.

---

### Task 1: Stop-command recogniser

**Files:**
- Modify: `src/director/approval.ts`
- Test: `tests/director/approval.test.ts`

**Interfaces:**
- Consumes: the private `normalise` and `MAX_WORDS` already in `approval.ts`.
- Produces: `export function isStopCommand(text: string): boolean`

Lives in `approval.ts` on purpose: it is the same responsibility — reading a short spoken command — and a separate module would mean exporting `normalise`, which exists to stay private.

**The stop set is not the `NO` set.** `NO` contains `aspetta`; the stop set must not. While it is working, *"aspetta"* means "hold on, I'm adding something" — the opposite of stop. Do not refactor the two into one.

- [ ] **Step 1: Write the failing tests**

```ts
import { isStopCommand } from '../../src/director/approval.ts';

test('a bare stop command stops', () => {
  for (const s of ['basta', 'stop', 'lascia stare', 'annulla', 'fermati', 'Basta.', '  STOP  ']) {
    assert.equal(isStopCommand(s), true, s);
  }
});

test('a stop word inside a longer sentence does not stop', () => {
  for (const s of [
    'non dirmi basta',
    'poi ti dico quando basta',
    'lascia stare quello e cercami il meteo',
  ]) {
    assert.equal(isStopCommand(s), false, s);
  }
});

test('aspetta does not stop, but is still a refusal for approvals', () => {
  // The two vocabularies overlap without being the same set (spec §3).
  assert.equal(isStopCommand('aspetta'), false);
  assert.equal(interpretApproval('aspetta'), 'no');
});

test('empty and hallucinated input never stops', () => {
  for (const s of ['', '   ', '[Musica]', '(rumore)']) assert.equal(isStopCommand(s), false);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test tests/director/approval.test.ts`
Expected: FAIL — `isStopCommand` is not exported.

- [ ] **Step 3: Implement**

```ts
/**
 * Deliberately NOT the `NO` set, which contains "aspetta". For a permission
 * answer that is a refusal; for work in flight it almost always means "hold on,
 * I am adding something" — the opposite of stopping. The sets overlap; merging
 * them would silently cancel work the user was trying to extend.
 */
const STOP = new Set([
  'basta', 'stop', 'lascia stare', 'lascia perdere',
  'annulla', 'annullalo', 'ferma', 'fermati', 'fermo',
]);

/** Whole-utterance match, like interpretApproval: "non dirmi basta" is not a stop. */
export function isStopCommand(text: string): boolean {
  const normalised = normalise(text);
  if (!normalised) return false;
  if (normalised.split(' ').length > MAX_WORDS) return false;
  return STOP.has(normalised);
}
```

- [ ] **Step 4: Run the tests, then the suite**

Run: `node --test tests/director/approval.test.ts && npm test && npm run typecheck`
Expected: PASS, and no existing approval test regresses.

- [ ] **Step 5: Commit**

```bash
git add src/director/approval.ts tests/director/approval.test.ts
git commit -m "feat: recognise a bare spoken stop command"
```

---

### Task 2: Barge-in only while speaking

**Files:**
- Modify: `src/director/director.ts` (`#onFrame`, `#onSpeechStart`, `#onTurnEnd`)
- Test: `tests/director/director.test.ts`

**Interfaces:**
- Consumes: `isStopCommand` from Task 1.
- Produces: no signature change. Behavioural only.

This is the defect that cancelled a live search. §6 line 411 always scoped barge-in to `SPEAKING`; `director.ts` added `THINKING` on its own.

`#state` currently answers two questions at once — *what is the agent doing* and *am I recording the user* — which must now both be true. Do not add a fifth state. Move the decision instead: capture whenever the detector reports speech, and let `#onTurnEnd` route by state.

- [ ] **Step 1: Write the failing tests**

```ts
test('speech while thinking does not interrupt the turn', async () => {
  const f = makeFakes();
  const d = new Director(f.deps);
  await d.start();
  f.agent.holdTurn();            // first token not yet emitted
  f.turns.speak('quando gioca il napoli');
  await f.turns.endTurn();
  assert.equal(d.state, 'THINKING');

  f.turns.speak('allora');       // the prompt that used to kill the search
  await f.turns.endTurn();
  assert.equal(f.agent.interrupts, 0, 'thinking is not interruptible');
  assert.equal(d.state, 'THINKING', 'the turn survives');
});

test('speech while speaking still interrupts', async () => {
  const f = makeFakes();
  const d = new Director(f.deps);
  await d.start();
  f.turns.speak('domanda');
  await f.turns.endTurn();
  await f.agent.emitText('Questa è una risposta lunga.');
  assert.equal(d.state, 'SPEAKING');

  f.turns.speak('no aspetta');
  await tick();
  assert.equal(f.agent.interrupts, 1, 'barge-in is the whole point of the project');
});

test('a bare stop command while thinking cancels the turn', async () => {
  const f = makeFakes();
  const d = new Director(f.deps);
  await d.start();
  f.agent.holdTurn();
  f.turns.speak('cerca qualcosa');
  await f.turns.endTurn();

  f.turns.speak('basta');
  await f.turns.endTurn();
  assert.equal(f.agent.interrupts, 1);
  assert.equal(d.state, 'LISTENING');
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test tests/director/director.test.ts`
Expected: FAIL — the first asserts `interrupts === 0` and today's code interrupts on `THINKING`.

- [ ] **Step 3: Implement**

In `#onFrame`, feed whisper whenever the detector hears speech rather than only in two states:

```ts
  #onFrame(frame: AudioFrame): void {
    this.#deps.turns.push(frame, this.#lastPartial);
    // Capture in every state. THINKING must be able to record the user without
    // ceasing to be THINKING: what they say is a follow-up, not a cancellation.
    if (this.#state !== 'LISTENING' || this.#capturing) this.#stream?.push(frame);
  }
```

Add `#capturing = false`, set true in `#onSpeechStart` and false when a turn is routed.

In `#onSpeechStart`, drop `THINKING` from the interruptible set:

```ts
  #onSpeechStart(): void {
    this.#capturing = true;
    if (this.#state === 'HEARING' || this.#state === 'AWAITING_APPROVAL') return;
    // SPEAKING only. THINKING is silent work: talking during it adds to the
    // conversation (spec §1/§2) instead of destroying it.
    if (this.#state === 'SPEAKING') {
      this.#state = 'HEARING';
      void this.#bargeIn();
    }
  }
```

In `#onTurnEnd`, route by state. Replace the leading state guard:

```ts
    if (this.#state === 'THINKING') {
      const id = this.#turnId;
      const said = await this.#takeFinal();
      if (this.#turnId !== id) return;
      this.#capturing = false;
      if (isStopCommand(said)) {
        this.#turnId++;
        this.#tts?.abort();
        this.#stopFiller();
        void this.#deps.agent.interrupt();
        this.#state = 'LISTENING';
        return;
      }
      if (said) this.#queued.push(said);   // Task 3 consumes this
      return;
    }
```

- [ ] **Step 4: Run the tests and the suite**

Run: `npm test && npm run typecheck`
Expected: PASS. Watch for existing tests that assumed thinking was interruptible; if one fails, it encoded the bug and its expectation changes — say so in the commit.

- [ ] **Step 5: Commit**

```bash
git add src/director/director.ts tests/director/director.test.ts
git commit -m "fix: barge-in only while actually speaking, per spec §6"
```

---

### Task 3: Queue what was said during the turn

**Files:**
- Modify: `src/director/director.ts`
- Test: `tests/director/director.test.ts`

**Interfaces:**
- Consumes: `#queued: string[]` written by Task 2.
- Produces: no signature change.

- [ ] **Step 1: Write the failing tests**

```ts
test('a follow-up said while thinking is answered after the current answer', async () => {
  const f = makeFakes();
  const d = new Director(f.deps);
  await d.start();
  f.agent.holdTurn();
  f.turns.speak('quando gioca il napoli');
  await f.turns.endTurn();

  f.turns.speak('e anche che tempo fa');
  await f.turns.endTurn();

  await f.agent.emitText('Gioca domenica.');
  await f.agent.finishTurn();
  await tick();

  assert.deepEqual(f.agent.sent, ['quando gioca il napoli', 'e anche che tempo fa']);
});

test('a hallucinated transcript is never queued', async () => {
  const f = makeFakes();
  const d = new Director(f.deps);
  await d.start();
  f.agent.holdTurn();
  f.turns.speak('domanda');
  await f.turns.endTurn();

  f.turns.speak('[Musica]');
  await f.turns.endTurn();
  await f.agent.emitText('Risposta.');
  await f.agent.finishTurn();
  await tick();

  assert.deepEqual(f.agent.sent, ['domanda'], 'a cough is not a question');
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test tests/director/director.test.ts`
Expected: FAIL — nothing drains `#queued`.

- [ ] **Step 3: Implement**

`#takeFinal` already runs its result through `clean()`, so hallucinations are filtered before they reach `#queued`. Drain at the end of `#run`, where the turn returns to `LISTENING`:

```ts
    if (this.#turnId !== id) return;
    this.#stopFiller();
    this.#state = 'LISTENING';

    // Said while the answer was in flight. It was deliberately not allowed to
    // interrupt, so it must not be silently dropped either.
    const next = this.#queued.shift();
    if (next !== undefined) this.#ask(next);
```

Clear `#queued` wherever a turn is abandoned — `#abandon`, `stop()`, and the stop-command path — so a cancelled line of thought does not resurrect.

- [ ] **Step 4: Run the tests and the suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/director/director.ts tests/director/director.test.ts
git commit -m "feat: queue what the user says while a turn is in flight"
```

---

### Task 4: Count the Director's own speech separately

**Files:**
- Modify: `src/director/director.ts` (`#emit`, `#say`, `#play`, `#heardPrefix`, `#run`)
- Test: `tests/director/director.test.ts`

**Interfaces:**
- Produces: `#emit(frame, sinks, kind: 'answer' | 'aside')`, `#asideMs: number`.

**Do this before Task 5 or the progress lines are born broken.** The spec says progress lines must not move `#answerFromMs`, which is true but not sufficient: `#say` emits through `#emit` (`director.ts:391`), which increments `#enqueuedMs`, and `answerMs` is `#enqueuedMs - #answerFromMs`. A line spoken *during* a tool call — after the answer has already begun — therefore inflates the answer's measured duration and skews the prefix, even though `#answerFromMs` never moved.

Fillers today escape this only because they play *before* the first answer frame.

- [ ] **Step 1: Write the failing test**

```ts
test('a line spoken mid-answer does not distort what the user heard', async () => {
  const f = makeFakes();
  const d = new Director(f.deps);
  await d.start();
  f.turns.speak('domanda');
  await f.turns.endTurn();

  await f.agent.emitText('Prima frase. Seconda frase.');
  await d.sayAside('sto ancora guardando');   // exposed for the test via Task 5's path
  f.audioOut.pendingMs = 0;                    // everything was rendered

  f.turns.speak('ok basta');
  await tick();
  // Without aside accounting the answer looks longer than it was and the
  // prefix comes back truncated, telling Claude the user missed words they heard.
  assert.equal(f.agent.notes.at(-1)?.spokenSoFar, 'Prima frase. Seconda frase.');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/director/director.test.ts`
Expected: FAIL — the prefix is truncated by the aside's duration.

- [ ] **Step 3: Implement**

```ts
  /** Audio the Director spoke on its own behalf since this answer began. */
  #asideMs = 0;

  #emit(frame: AudioFrame, sinks: OutputSink[], kind: 'answer' | 'aside'): void {
    const ms = (frame.length / this.#deps.config.audio.deviceRate) * 1000;
    this.#enqueuedMs += ms;
    if (kind === 'aside') this.#asideMs += ms;
    this.#deps.audioOut.enqueue(frame);
    for (const sink of sinks) sink.onAudio(frame);
  }
```

`#say` passes `'aside'`; `#play` passes `'answer'`. Reset `#asideMs = 0` wherever `#answerFromMs` is set (in `#run` and at the first frame in `#play`).

In `#heardPrefix`, remove the asides from both sides of the proportion:

```ts
    const answerMs = this.#enqueuedMs - this.#answerFromMs - this.#asideMs;
    if (!text || answerMs <= 0) return '';
    // Asides and answer never overlap, and an aside always precedes the answer
    // audio queued after it, so subtracting the total is exact whenever the
    // asides were fully played. Barging in mid-aside overcounts slightly; the
    // clamp below is what keeps that honest.
    const heardOfAnswer = Math.min(heardMs - this.#answerFromMs - this.#asideMs, answerMs);
```

- [ ] **Step 4: Run the tests and the suite**

Run: `npm test && npm run typecheck`
Expected: PASS, including the existing barge-in prefix tests.

- [ ] **Step 5: Commit**

```bash
git add src/director/director.ts tests/director/director.test.ts
git commit -m "fix: keep the Director's own lines out of the answer's duration"
```

---

### Task 5: Say what it is doing during a tool call

**Files:**
- Modify: `src/director/director.ts` (`#run`), `src/types.ts` if a doc line is needed
- Create: `src/director/progress.ts`
- Test: `tests/director/progress.test.ts`, `tests/director/director.test.ts`

**Interfaces:**
- Consumes: `AgentEvent`'s `{ type: 'tool'; name: string; phase: 'start' | 'end' }` (`src/types.ts:69`), and `#emit(..., 'aside')` from Task 4.
- Produces: `export function progressLine(tool: string, index: number): string`

`AgentEvent` has carried tool brackets since M1 with no consumer — `director.ts` contains zero occurrences of "tool". `filter.filter(agent.send(text))` eats the whole stream and yields only sentences, so interpose a pass-through generator that observes and forwards unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/director/progress.test.ts
test('names the action, never the tool or its arguments', () => {
  assert.equal(progressLine('WebSearch', 0), 'Sto cercando sul web.');
  assert.equal(progressLine('Read', 0), 'Sto leggendo.');
  for (const tool of ['WebSearch', 'Read', 'Bash', 'Inventato']) {
    const line = progressLine(tool, 0);
    assert.ok(!line.includes(tool), `${tool} leaked into speech`);
    assert.ok(!/[/_]|\.ts\b/.test(line), `${line} reads like a path (§7)`);
  }
});

test('an unknown tool still says something human', () => {
  assert.ok(progressLine('QualcosaDiNuovo', 0).length > 0);
});

test('consecutive lines differ', () => {
  assert.notEqual(progressLine('WebSearch', 0), progressLine('WebSearch', 1));
});
```

```ts
// tests/director/director.test.ts
test('a long tool call is narrated, and stops when the tool ends', async () => {
  const f = makeFakes();
  const d = new Director(f.deps);
  await d.start();
  f.turns.speak('cerca il napoli');
  await f.turns.endTurn();
  await f.agent.emitText('Aspetta, controllo.');
  await f.agent.emitTool('WebSearch', 'start');

  f.clock.advance(3000);
  await tick();
  assert.equal(f.voice.lines.length, 1, 'it says it is still working');

  await f.agent.emitTool('WebSearch', 'end');
  f.clock.advance(9000);
  await tick();
  assert.equal(f.voice.lines.length, 1, 'and stops once the tool is done');
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test tests/director/progress.test.ts tests/director/director.test.ts`
Expected: FAIL — `progress.ts` does not exist.

- [ ] **Step 3: Implement**

```ts
// src/director/progress.ts
/**
 * §7 forbids reading identifiers out loud, and a tool name is an identifier.
 * Every line names the ACTION. Unknown tools fall back to something equally
 * human rather than leaking the name.
 */
const LINES: Record<string, readonly string[]> = {
  WebSearch: ['Sto cercando sul web.', 'Sto ancora cercando.', 'Ci vuole un attimo.'],
  WebFetch: ['Sto aprendo la pagina.', 'Sto ancora leggendo la pagina.'],
  Read: ['Sto leggendo.', 'Sto ancora leggendo.'],
  Grep: ['Sto cercando nel testo.', 'Ci sono quasi.'],
  Glob: ['Sto cercando il file.', 'Ci sono quasi.'],
  Bash: ['Sto eseguendo.', 'Ci vuole ancora un momento.'],
};
const FALLBACK = ['Un attimo che finisco.', 'Ci sto ancora lavorando.', 'Ci sono quasi.'];

export function progressLine(tool: string, index: number): string {
  const lines = LINES[tool] ?? FALLBACK;
  return lines[index % lines.length]!;
}
```

In `#run`, wrap the event stream:

```ts
    const director = this;
    const observed = (async function* () {
      for await (const event of director.#deps.agent.send(text)) {
        if (event.type === 'tool') {
          if (event.phase === 'start') director.#startProgress(event.name);
          else director.#stopProgress();
        }
        yield event;
      }
    })();
    // …then feed `observed` to the filter where `agent.send(text)` was.
```

`#startProgress` sets a repeating 3 s timer through `this.#timers` speaking `progressLine(tool, i++)` via `#say`; `#stopProgress` clears it and aborts the line. Both must also run from `#stopFiller`-adjacent teardown paths: `#abandon`, `stop()`, barge-in, and the first sentence of the answer.

- [ ] **Step 4: Run the tests and the suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/director/progress.ts src/director/director.ts tests/director/
git commit -m "feat: say what it is doing while a tool runs"
```

---

### Task 6: Per-turn diagnostics behind AXA_DEBUG

**Files:**
- Modify: `src/director/director.ts`, `README.md`
- Test: `tests/director/director.test.ts`

**Interfaces:**
- Produces: a `#debug(...)` private that no-ops unless `process.env.AXA_DEBUG` is set.

During the live failure the only diagnosis available was "it isn't working well", because the process printed nothing between startup and shutdown. That absence is itself a defect, and Task 7 cannot be done without this.

- [ ] **Step 1: Write the failing test**

```ts
test('diagnostics stay silent unless asked for', async () => {
  const lines: string[] = [];
  const f = makeFakes({ debug: (m: string) => lines.push(m) });
  // …run one turn…
  assert.equal(lines.length, 0, 'a quiet default: this is a voice app, not a log');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/director/director.test.ts`
Expected: FAIL — no `debug` hook exists.

- [ ] **Step 3: Implement**

Add an optional `debug?: (message: string) => void` to `DirectorDeps`, wired in `src/cli.ts` to `process.env.AXA_DEBUG ? console.error : undefined`. Emit one line per state transition and one per turn boundary carrying: transcript, state, tool name, `#enqueuedMs`, `#answerFromMs`, `#asideMs`, `heardMs`, resulting prefix.

- [ ] **Step 4: Run the tests and the suite**

Run: `npm test && npm run typecheck`

- [ ] **Step 5: Document and commit**

Add a line to README under Tests: `AXA_DEBUG=1 npm start` prints the turn trace.

```bash
git add src/director/director.ts src/cli.ts tests/director/director.test.ts README.md
git commit -m "feat: per-turn trace behind AXA_DEBUG"
```

---

### Task 7: Measure, then fix, the empty heard-prefix

**Files:**
- Modify: `src/director/director.ts` (`#bargeIn`)
- Test: `tests/director/director.test.ts`

**Interfaces:**
- Consumes: the trace from Task 6.

**Measure first — the spec records a hypothesis, not a finding.** The fix is one line, which is exactly why it is tempting to apply it unverified, watch the symptom disappear, and never learn whether the cause was understood.

- [ ] **Step 1: Reproduce and record**

Run `AXA_DEBUG=1 npm start`, ask something that takes a tool call, barge in **twice** in one session. Record `#enqueuedMs`, `#answerFromMs`, `#asideMs`, `heardMs` and the prefix at each barge-in. Paste them into the commit message.

Hypothesis to confirm: `heardMs` falls behind `#enqueuedMs` by exactly the audio `flush()` discarded, so the gap grows per barge-in until `heardMs - #answerFromMs` goes negative and the prefix is `''`.

- [ ] **Step 2: Write the failing regression test**

```ts
test('the prefix survives a second barge-in in the same session', async () => {
  // The first barge-in passing proves nothing: the timelines only diverge once
  // audio has been dropped.
  const f = makeFakes();
  const d = new Director(f.deps);
  await d.start();

  for (const [question, answer] of [['una', 'Prima risposta lunga.'], ['due', 'Seconda risposta lunga.']]) {
    f.turns.speak(question);
    await f.turns.endTurn();
    await f.agent.emitText(answer);
    f.audioOut.pendingMs = f.audioOut.enqueuedMs / 2;   // half of it never played
    f.turns.speak('aspetta');
    await tick();
  }

  const note = f.agent.notes.at(-1)!.spokenSoFar;
  assert.ok(note.length > 0, 'the second barge-in must not claim nothing was heard');
  assert.ok('Seconda risposta lunga.'.startsWith(note), `"${note}" is not a prefix of the answer`);
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `node --test tests/director/director.test.ts`
Expected: FAIL — the second note is `''`.

- [ ] **Step 4: Implement, only if the measurement agreed**

In `#bargeIn`, after the flush:

```ts
    const { heardMs } = await this.#deps.audioOut.flush();
    this.#pendingNote = this.#heardPrefix(heardMs);
    // flush() discarded whatever had not been rendered, but those milliseconds
    // were already counted here. Re-synchronise: after a flush, what the device
    // rendered IS everything that ever reached the speakers. Without this the
    // two timelines drift apart by the dropped audio at every barge-in, and the
    // note eventually reports that nothing was heard at all.
    this.#enqueuedMs = heardMs;
```

If the measurement *disagreed*, stop and report rather than applying this.

- [ ] **Step 5: Run the tests and the suite**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit, with the numbers**

```bash
git add src/director/director.ts tests/director/director.test.ts
git commit -m "fix: re-synchronise the playback timeline after a flush"
```

---

### Task 8: Reconcile the documents

**Files:**
- Modify: `docs/superpowers/specs/2026-09-11-voice-agent-design.md` (§6), `README.md`

**Interfaces:** none.

The M1 spec is the document people read first. Leaving §6 describing a barge-in rule the Director no longer implements alone recreates the original divergence.

- [ ] **Step 1: Amend §6**

Add, next to the interrupt sequence, that barge-in is scoped to `SPEAKING`; that speech during `THINKING` is captured, checked against `isStopCommand`, and otherwise queued; and a pointer to `2026-09-12-interruption-model-design.md`.

- [ ] **Step 2: Update the README**

The behaviour table promises interruption; add that talking while it works adds to the conversation rather than cancelling it, and that it says what it is doing during a long search. Update the test count.

- [ ] **Step 3: Commit**

```bash
git add docs/ README.md
git commit -m "docs: reconcile §6 with the implemented interruption model"
```

---

## Self-review

**Spec coverage.** §1 → Task 2. §2 → Tasks 2–3. §3 → Task 1. §4 → Tasks 4–5. §5 → Tasks 6–7. §6 testing → distributed, with the two-barge-in regression in Task 7.

**Ordering.** Task 4 precedes Task 5 because progress lines emitted through `#say` would otherwise inflate the answer duration from birth. Task 6 precedes Task 7 because the measurement is the gate on the fix.

**Names.** `isStopCommand`, `progressLine`, `#emit(frame, sinks, kind)`, `#asideMs`, `#queued`, `#capturing`, `#startProgress` / `#stopProgress` are used consistently across tasks.

**Known gap, deliberate.** Task 4's subtraction is exact only when asides were fully rendered before the barge-in; interrupting mid-aside overcounts slightly and is absorbed by the existing clamp. Proportioning by character count is already the spec's stated approximation, so this does not introduce a new class of error.
