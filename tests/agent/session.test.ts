import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOptions, ClaudeAgentSession, WARM_UP_MESSAGE } from '../../src/agent/session.ts';
import { loadConfig } from '../../src/config.ts';
import type { AgentEvent } from '../../src/types.ts';

const config = loadConfig({ CARTESIA_API_KEY: 'sk_test' });

// ---------------------------------------------------------------------------
// A fake of the two SDK surfaces this module touches: `startup()` and the
// `Query` it hands back. Everything the session does to the SDK is recorded,
// because the bugs that matter here are "which SDK call did you make" bugs:
// interrupt vs abort, and whether the long-lived query got closed.
// ---------------------------------------------------------------------------

interface FakeSdk {
  startupFn: never;
  /** Push one SDK message into the session's pump. */
  emit(message: unknown): void;
  /** Make the pump's next read reject, as a transport error would. */
  fail(error: Error): void;
  /** Text the session actually handed to Claude, in order. Never includes "/clear" (see `clears`). */
  prompts: string[];
  /** How many "/clear" local commands the session has pushed (see #clearConversation). */
  clears: number;
  /** Answers each "/clear" with a conversation_reset message immediately, unless disabled. */
  autoAnswerClear: boolean;
  /** Options the session passed to startup(). */
  options: Record<string, unknown> | undefined;
  interrupts: number;
  /** Non-zero means the long-lived query was torn down. */
  returns: number;
  /** Emitted automatically when interrupt() is called, unless disabled. */
  resultOnInterrupt: boolean;
  /** Answers start()'s warm-up message immediately, unless disabled. */
  autoAnswerWarmUp: boolean;
  /**
   * interrupt() never resolves, the way the SDK gives no guarantee it will
   * while a background subagent Task is still running (spec: 2026-09-26).
   */
  hangInterrupt: boolean;
  /**
   * interrupt() rejects instead of hanging or resolving, the way a real
   * control-protocol request can fail outright (e.g. "control request failed:
   * session not initialized") rather than merely being slow.
   */
  rejectInterrupt: boolean;
  /**
   * Resolves every interrupt() call still hung, as if the SDK had eventually
   * (if belatedly) come back. Real interrupt() calls do not hang forever
   * either, and leaving the fake's promise permanently unresolved trips
   * node:test's own dangling-promise detection at process exit.
   */
  releaseInterrupts(): void;
  /** Every mode setPermissionMode() was called with, in order. */
  permissionModes: string[];
  /**
   * Models the real CLI's single-ordered-turn-stream constraint: when set,
   * the fake will not read (and act on) message N+1 until a `result` for
   * message N has been reported via emit().
   */
  strictTurnOrdering: boolean;
}

function makeFakeSdk(): FakeSdk {
  const queued: unknown[] = [];
  let notify: (() => void) | undefined;
  let closed = false;
  let failure: Error | undefined;

  const state = {
    prompts: [] as string[],
    options: undefined as Record<string, unknown> | undefined,
    interrupts: 0,
    returns: 0,
    resultOnInterrupt: true,
    autoAnswerWarmUp: true,
    autoAnswerClear: true,
    hangInterrupt: false,
    rejectInterrupt: false,
    permissionModes: [] as string[],
    strictTurnOrdering: false,
    clears: 0,
  };

  const wake = (): void => {
    notify?.();
    notify = undefined;
  };
  // Only meaningful while state.strictTurnOrdering is on: gates the fake's
  // consumption loop so it never reads a turn N+1 before turn N's own result
  // has been reported, mirroring the real CLI's single ordered stream.
  let resultPending = false;
  let resultWaiters: Array<() => void> = [];
  const waitUntilResultReported = (): Promise<void> => {
    if (!resultPending) return Promise.resolve();
    return new Promise<void>((resolve) => {
      resultWaiters.push(resolve);
    });
  };
  const reportResult = (): void => {
    resultPending = false;
    const waiters = resultWaiters;
    resultWaiters = [];
    for (const resolve of waiters) resolve();
  };
  const emit = (message: unknown): void => {
    queued.push(message);
    if (state.strictTurnOrdering && (message as { type?: string }).type === 'result') reportResult();
    wake();
  };
  const hungInterrupts: Array<() => void> = [];

  const query = {
    async next(): Promise<IteratorResult<unknown>> {
      for (;;) {
        if (failure) {
          const error = failure;
          failure = undefined;
          throw error;
        }
        if (queued.length > 0) return { value: queued.shift(), done: false };
        if (closed) return { value: undefined, done: true };
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    },
    async return(value: unknown): Promise<IteratorResult<unknown>> {
      state.returns += 1;
      closed = true;
      wake();
      return { value, done: true };
    },
    async throw(error: unknown): Promise<IteratorResult<unknown>> {
      throw error;
    },
    [Symbol.asyncIterator]() {
      return query;
    },
    async interrupt(): Promise<undefined> {
      state.interrupts += 1;
      // A real control-protocol request can fail outright rather than merely
      // being slow (e.g. "control request failed: session not initialized"),
      // especially in exactly the scenario the warm-up give-up path handles:
      // the session already misbehaving.
      if (state.rejectInterrupt) throw new Error('control request failed: session not initialized');
      // The SDK gives no guarantee interrupt() returns promptly (spec:
      // 2026-09-26): never resolving within a caller's bound is the real,
      // observed failure mode this simulates. Held open well past any
      // bound a test exercises, rather than truly eternal — a promise with
      // nothing at all scheduled to ever settle it trips node:test's own
      // dangling-async-resource detection, even mid-test.
      if (state.hangInterrupt) {
        return new Promise<undefined>((resolve) => {
          const timer = setTimeout(() => resolve(undefined), 1000);
          hungInterrupts.push(() => {
            clearTimeout(timer);
            resolve(undefined);
          });
        });
      }
      // The real CLI ends the interrupted turn with a result message.
      if (state.resultOnInterrupt) emit({ type: 'result', subtype: 'error_during_execution' });
      return undefined;
    },
    async setPermissionMode(mode: string): Promise<void> {
      state.permissionModes.push(mode);
    },
  };

  const startupFn = async (params: { options?: Record<string, unknown> }) => {
    state.options = params.options;
    return {
      query(prompt: AsyncIterable<{ message: { content: string } }>) {
        void (async () => {
          let first = true;
          const iterator = prompt[Symbol.asyncIterator]();
          for (;;) {
            // The real CLI processes turns over a single ordered stream: it
            // will not start on a new one before the previous one's result
            // has been reported.
            if (state.strictTurnOrdering) await waitUntilResultReported();
            const next = await iterator.next();
            if (next.done) return;
            const content = next.value.message.content;
            // "/clear" is the CLI's own local command (#clearConversation):
            // it never reaches the model, is confirmed with a dedicated
            // conversation_reset message instead of a turn result, and must
            // never show up in `prompts` (which models real model turns).
            if (content === '/clear') {
              state.clears += 1;
              if (state.autoAnswerClear) {
                emit({
                  type: 'conversation_reset',
                  new_conversation_id: 'fake-conversation',
                  uuid: 'fake-uuid',
                  session_id: 'fake-session',
                });
              }
              continue;
            }
            state.prompts.push(content);
            if (state.strictTurnOrdering) resultPending = true;
            // start()'s warm-up is always the first message pushed to a fresh
            // session; answer it immediately so tests do not have to know it
            // happened at all unless they are specifically testing for it.
            if (first) {
              first = false;
              if (state.autoAnswerWarmUp) emit({ type: 'result', subtype: 'success' });
            }
          }
        })();
        return query;
      },
      close() {
        closed = true;
        wake();
      },
    };
  };

  return {
    startupFn: startupFn as never,
    emit,
    fail(error: Error) {
      failure = error;
      wake();
    },
    get prompts() {
      return state.prompts;
    },
    get options() {
      return state.options;
    },
    get interrupts() {
      return state.interrupts;
    },
    get returns() {
      return state.returns;
    },
    get resultOnInterrupt() {
      return state.resultOnInterrupt;
    },
    set resultOnInterrupt(value: boolean) {
      state.resultOnInterrupt = value;
    },
    get autoAnswerWarmUp() {
      return state.autoAnswerWarmUp;
    },
    set autoAnswerWarmUp(value: boolean) {
      state.autoAnswerWarmUp = value;
    },
    get autoAnswerClear() {
      return state.autoAnswerClear;
    },
    set autoAnswerClear(value: boolean) {
      state.autoAnswerClear = value;
    },
    get clears() {
      return state.clears;
    },
    get hangInterrupt() {
      return state.hangInterrupt;
    },
    set hangInterrupt(value: boolean) {
      state.hangInterrupt = value;
    },
    get rejectInterrupt() {
      return state.rejectInterrupt;
    },
    set rejectInterrupt(value: boolean) {
      state.rejectInterrupt = value;
    },
    releaseInterrupts() {
      while (hungInterrupts.length > 0) hungInterrupts.pop()?.();
    },
    get permissionModes() {
      return state.permissionModes;
    },
    get strictTurnOrdering() {
      return state.strictTurnOrdering;
    },
    set strictTurnOrdering(value: boolean) {
      state.strictTurnOrdering = value;
    },
  };
}

/**
 * Reads the PreToolUse hook the session registered with start(), the same
 * way the tests already read sdk.options?.canUseTool directly, and returns a
 * function that invokes it with no arguments (the session's own hook ignores
 * them, see session.ts #denyToolsWhileSuppressed).
 */
function getPreToolUseDecision(sdk: FakeSdk): () => Promise<unknown> {
  const hooks = sdk.options?.hooks as
    | { PreToolUse?: Array<{ hooks: Array<() => Promise<unknown>> }> }
    | undefined;
  const hook = hooks?.PreToolUse?.[0]?.hooks?.[0];
  if (!hook) throw new Error('no PreToolUse hook registered on sdk.options');
  return () => hook();
}

function textDelta(text: string): unknown {
  return {
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  };
}

const RESULT = { type: 'result', subtype: 'success' };

/** Let the pump and the input-stream consumer run. */
async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function startSession(
  sdk: FakeSdk,
  overrides: Partial<{
    approvalTimeoutMs: number;
    interruptDrainMs: number;
    turnTimeoutMs: number;
    staleResultWindowMs: number;
    interruptTimeoutMs: number;
  }> = {},
): Promise<ClaudeAgentSession> {
  const cfg =
    overrides.approvalTimeoutMs ?? overrides.turnTimeoutMs ?? overrides.interruptTimeoutMs
      ? ({
          ...config,
          director: {
            ...config.director,
            approvalTimeoutMs: overrides.approvalTimeoutMs ?? config.director.approvalTimeoutMs,
            turnTimeoutMs: overrides.turnTimeoutMs ?? config.director.turnTimeoutMs,
            interruptTimeoutMs: overrides.interruptTimeoutMs ?? config.director.interruptTimeoutMs,
          },
        } as never)
      : config;
  const session = new ClaudeAgentSession(cfg, {
    startupFn: sdk.startupFn,
    interruptDrainMs: overrides.interruptDrainMs,
    staleResultWindowMs: overrides.staleResultWindowMs,
  });
  await session.start();
  await settle();
  // start()'s own warm-up message is real traffic (spec: session.ts #warmUp),
  // but tests that predate it assert prompts() against exactly the turns
  // they themselves sent. Drop it here, once, rather than teach every test
  // about a message none of them are about. Same for the plan-mode entry/exit
  // pair the warm-up itself causes (spec: session.ts #enterPlanMode).
  sdk.prompts.length = 0;
  sdk.permissionModes.length = 0;
  return session;
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

// --- Options ---------------------------------------------------------------

test('MCP is disabled three ways, because one is not enough', () => {
  const options = buildOptions(config);
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.mcpServers, {});
  assert.deepEqual(
    options.settingSources,
    ['user'],
    'must be explicit: the default loads every source and restores the 5-7s MCP cost',
  );
});

test('partial messages are on, or text arrives in blocks instead of tokens', () => {
  assert.equal(buildOptions(config).includePartialMessages, true);
});

test('the system prompt appends to the preset rather than replacing it', () => {
  const prompt = buildOptions(config).systemPrompt;
  assert.equal(typeof prompt, 'object', 'a bare string REPLACES the preset');
  assert.equal((prompt as { type: string }).type, 'preset');
  assert.ok((prompt as { append?: string }).append, 'spoken-style guidance must be appended');
});

test('only read-only tools are pre-approved', () => {
  const allowed = buildOptions(config).allowedTools ?? [];
  assert.ok(allowed.includes('Read'));
  assert.ok(allowed.includes('WebSearch'));
  for (const dangerous of ['Bash', 'Write', 'Edit']) {
    assert.ok(!allowed.includes(dangerous), `${dangerous} must require spoken consent`);
  }
});

// --- Event mapping ---------------------------------------------------------

test('text deltas become AgentEvents', async () => {
  const sdk = makeFakeSdk();
  const session = await startSession(sdk);
  const events = drain(session.send('ciao'));

  await settle();
  sdk.emit(textDelta('Ciao'));
  sdk.emit(textDelta(' mondo'));
  sdk.emit(RESULT);

  const deltas = (await events).filter((e) => e.type === 'text').map((e) => e.delta);
  assert.deepEqual(deltas, ['Ciao', ' mondo']);
  await session.close();
});

test('the end of a text block is signalled, or the last sentence waits for the next tool', async () => {
  // Measured: a sentence that ends a text block sat unspoken for 16 s because
  // nothing told the consumer the block was over — and it was the filler line
  // covering a slow web search. The block end must reach the stream.
  const sdk = makeFakeSdk();
  const session = await startSession(sdk);
  const events = drain(session.send('cerca il meteo'));

  await settle();
  sdk.emit({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  });
  sdk.emit(textDelta('Aspetta che controllo.'));
  sdk.emit({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_stop', index: 0 },
  });
  sdk.emit(RESULT);

  const deltas = (await events).filter((e) => e.type === 'text').map((e) => e.delta);
  assert.deepEqual(deltas, ['Aspetta che controllo.', '\n']);
  await session.close();
});

test('tool use is bracketed by start and end events', async () => {
  const sdk = makeFakeSdk();
  const session = await startSession(sdk);
  const events = drain(session.send('cerca il meteo'));

  await settle();
  sdk.emit({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'tu_1', name: 'WebSearch', input: {} },
    },
  });
  sdk.emit({
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
  });
  sdk.emit(RESULT);

  const tools = (await events).filter((e) => e.type === 'tool');
  assert.deepEqual(tools, [
    { type: 'tool', name: 'WebSearch', phase: 'start' },
    { type: 'tool', name: 'WebSearch', phase: 'end' },
  ]);
  await session.close();
});

test('thinking is never spoken', async () => {
  const sdk = makeFakeSdk();
  const session = await startSession(sdk);
  const events = drain(session.send('pensa'));

  await settle();
  sdk.emit({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'hmm, forse...' },
    },
  });
  sdk.emit(textDelta('Ecco.'));
  sdk.emit(RESULT);

  const deltas = (await events).filter((e) => e.type === 'text').map((e) => e.delta);
  assert.deepEqual(deltas, ['Ecco.'], 'thinking deltas must not reach the speakers');
  await session.close();
});

test('subagent output is not spoken as if it were the main turn', async () => {
  // Deltas are emitted for the main session only; anything carrying a
  // parent_tool_use_id belongs to a sidechain (spec §12).
  const sdk = makeFakeSdk();
  const session = await startSession(sdk);
  const events = drain(session.send('delega'));

  await settle();
  sdk.emit({
    type: 'stream_event',
    parent_tool_use_id: 'tu_9',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'roba interna' } },
  });
  sdk.emit(textDelta('Fatto.'));
  sdk.emit(RESULT);

  const deltas = (await events).filter((e) => e.type === 'text').map((e) => e.delta);
  assert.deepEqual(deltas, ['Fatto.']);
  await session.close();
});

test('the turn ends with done', async () => {
  const sdk = makeFakeSdk();
  const session = await startSession(sdk);
  const events = drain(session.send('ciao'));
  await settle();
  sdk.emit(textDelta('Ciao.'));
  sdk.emit(RESULT);
  assert.deepEqual(await events, [
    { type: 'text', delta: 'Ciao.' },
    { type: 'done' },
  ]);
  await session.close();
});

test('a genuine error result surfaces instead of ending the turn as done', async () => {
  // An interrupted turn's result is an error too, and must NOT throw — that is
  // the expected end of a turn we cut. But an error the caller did not ask for
  // (budget, max turns, a crashed tool) must surface, or the user hears silence
  // where an apology belongs.
  const sdk = makeFakeSdk();
  const session = await startSession(sdk);
  const events = drain(session.send('fai qualcosa'));
  await settle();
  sdk.emit({ type: 'result', subtype: 'error_max_turns', is_error: true });
  await assert.rejects(() => events, /error_max_turns/);
  await session.close();
});

test('send() before start() is an error, not a silent no-op', () => {
  const session = new ClaudeAgentSession(config, { startupFn: makeFakeSdk().startupFn });
  assert.rejects(
    () => drain(session.send('ciao')),
    /start\(\)/,
    'a dropped turn is invisible in voice',
  );
});

// --- Warm-up -----------------------------------------------------------------

test('start() sends exactly one throwaway message before resolving', async () => {
  // The message triggers the first real model round trip during boot (spec:
  // session.ts #warmUp) instead of on the caller's first send().
  const sdk = makeFakeSdk();
  const session = new ClaudeAgentSession(config, { startupFn: sdk.startupFn });
  await session.start();
  await settle();

  assert.deepEqual(sdk.prompts, [WARM_UP_MESSAGE], 'start() must push exactly one throwaway message');
  await session.close();
});

test('start() erases the warm-up exchange from the shared conversation via "/clear"', async () => {
  // The WarmQuery handle can only be sent a prompt once (sdk.d.ts:
  // "Can only be called once per WarmQuery"), so the warm-up message and the
  // caller's real first turn are necessarily the same long-lived SDK
  // conversation. Without an explicit "/clear", the warm-up's own throwaway
  // exchange would sit in context forever, on every later turn.
  const sdk = makeFakeSdk();
  const session = new ClaudeAgentSession(config, { startupFn: sdk.startupFn });
  await session.start();
  await settle();

  assert.equal(sdk.clears, 1, 'start() must clear the warm-up exchange from context exactly once');
  await session.close();
});

test('a warm-up that settles normally is cleared only after plan mode has been exited', async () => {
  const sdk = makeFakeSdk();
  const session = new ClaudeAgentSession(config, { startupFn: sdk.startupFn });
  await session.start();
  await settle();

  assert.deepEqual(
    sdk.permissionModes,
    ['plan', 'default'],
    'plan mode must already be exited before the context clear runs',
  );
  assert.equal(sdk.clears, 1);
  await session.close();
});

test('a warm-up give-up still clears the throwaway exchange from context', async () => {
  // Mirrors "a warm-up give-up interrupts the CLI" below: even when the
  // warm-up times out and the turn is abandoned, its own user message and
  // whatever Claude said before being cut must not be left in the shared
  // conversation either.
  const sdk = makeFakeSdk();
  sdk.autoAnswerWarmUp = false; // the warm-up's throwaway message is never answered
  const fast = { ...config, director: { ...config.director, turnTimeoutMs: 20 } };
  const session = new ClaudeAgentSession(fast, { startupFn: sdk.startupFn, interruptDrainMs: 50 });
  const started = session.start();
  await new Promise((resolve) => setTimeout(resolve, 60)); // past turnTimeoutMs
  await started;

  assert.equal(sdk.clears, 1, 'a gave-up warm-up must still be cleared from context');
  await session.close();
});

test('the warm-up message never reaches a real send() as an event', async () => {
  const sdk = makeFakeSdk();
  const session = new ClaudeAgentSession(config, { startupFn: sdk.startupFn });
  await session.start();
  await settle();

  const events = drain(session.send('ciao'));
  await settle();
  sdk.emit(textDelta('Ciao.'));
  sdk.emit(RESULT);

  assert.deepEqual(await events, [
    { type: 'text', delta: 'Ciao.' },
    { type: 'done' },
  ]);
  assert.deepEqual(sdk.prompts, [WARM_UP_MESSAGE, 'ciao'], 'the warm-up turn precedes the real one, once');
  await session.close();
});

test('a normal send() after start() has no leftover state from the warm-up turn', async () => {
  const sdk = makeFakeSdk();
  const session = await startSession(sdk); // drops the warm-up entry from prompts

  const events = drain(session.send('cerca il meteo'));
  await settle();
  sdk.emit({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tu_1', name: 'WebSearch', input: {} },
    },
  });
  sdk.emit({
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
  });
  sdk.emit(RESULT);

  const tools = (await events).filter((e) => e.type === 'tool');
  assert.deepEqual(tools, [
    { type: 'tool', name: 'WebSearch', phase: 'start' },
    { type: 'tool', name: 'WebSearch', phase: 'end' },
  ]);
  assert.deepEqual(sdk.prompts, ['cerca il meteo'], 'turn tracking must start clean after the warm-up ends');
  await session.close();
});

test('a warm-up that never completes still lets start() resolve within its bound', async () => {
  const sdk = makeFakeSdk();
  sdk.autoAnswerWarmUp = false; // the model never answers the throwaway message

  const started = Date.now();
  const session = await startSession(sdk, { turnTimeoutMs: 50 });
  assert.ok(Date.now() - started < 500, 'a hung warm-up must not block app boot');
  assert.equal(sdk.interrupts, 1, 'the give-up path must stop the CLI still working on the abandoned turn');

  // The fake CLI acks the interrupt with a result automatically (the default
  // resultOnInterrupt behaviour), the same contract interrupt()'s drain
  // relies on. The session must still be usable afterwards.
  const events = drain(session.send('ciao'));
  await settle();
  sdk.emit(textDelta('Ciao.'));
  sdk.emit(RESULT);
  assert.deepEqual(await events, [
    { type: 'text', delta: 'Ciao.' },
    { type: 'done' },
  ]);
  await session.close();
});

test('a warm-up whose interrupt() itself never returns still lets start() resolve within its bound', async () => {
  // interrupt() has no guarantee of returning promptly while a background
  // subagent Task is still running (spec: 2026-09-26 — the same incident
  // the Director's own bounded-interrupt wrapper documents in director.ts
  // #interrupt). #warmUp sits directly on start(), and src/cli.ts awaits
  // that with no race of its own, so a hang here used to mean the process
  // never boots at all. It must be bounded by
  // config.director.interruptTimeoutMs, exactly like the Director bounds
  // its own call to the same method.
  const sdk = makeFakeSdk();
  sdk.autoAnswerWarmUp = false; // the model never answers the throwaway '.' message
  sdk.hangInterrupt = true; // interrupt() itself never resolves

  const fast = {
    ...config,
    director: { ...config.director, turnTimeoutMs: 50, interruptTimeoutMs: 80 },
  } as never;
  const session = new ClaudeAgentSession(fast, { startupFn: sdk.startupFn, interruptDrainMs: 50 });

  const started = Date.now();
  await session.start();
  assert.ok(Date.now() - started < 1000, 'a hung interrupt() must not block app boot forever');
  assert.equal(sdk.interrupts, 1, 'interrupt() must still have been attempted');
  sdk.releaseInterrupts(); // it does eventually come back, just not within budget

  // Neither interrupt() nor the drain came back in time, so the give-up path
  // armed the quarantine expecting the abandoned turn's belated result. The
  // CLI eventually reports it, same as it would after a real interrupt(); it
  // must be swallowed rather than mistaken for the real turn's own result,
  // exactly as #dispatch's stale-result handling already promises elsewhere.
  sdk.emit({ type: 'result', subtype: 'error_during_execution' });
  await settle();

  // The session must still be usable afterwards.
  const events = drain(session.send('ciao'));
  await settle();
  sdk.emit(textDelta('Ciao.'));
  sdk.emit(RESULT);
  assert.deepEqual(await events, [
    { type: 'text', delta: 'Ciao.' },
    { type: 'done' },
  ]);
  await session.close();
});

test('a warm-up whose interrupt() rejects still lets start() resolve, and the session stays usable', async () => {
  // withDeadline() only bounds a PENDING promise: it does nothing to protect
  // against the promise REJECTING outright. interrupt() is a control-protocol
  // request that can reject (e.g. "control request failed: session not
  // initialized"), especially in exactly the scenario the give-up path
  // handles — the session already misbehaving. Left unguarded, that rejection
  // used to propagate straight up through #warmUp() -> start(), which
  // src/cli.ts awaits with no race of its own: a rejection here aborted the
  // entire app boot over what is supposed to be a best-effort warm-up.
  const sdk = makeFakeSdk();
  sdk.autoAnswerWarmUp = false; // the model never answers the throwaway '.' message
  sdk.rejectInterrupt = true; // interrupt() rejects instead of hanging or resolving

  const session = await startSession(sdk, { turnTimeoutMs: 50 });
  assert.equal(sdk.interrupts, 1, 'the give-up path must still attempt interrupt() despite the rejection');

  // interrupt() rejected before it could ever emit the abandoned turn's own
  // result, so — same as when interrupt() merely hangs past its bound — the
  // drain also times out and the give-up path arms the stale-result
  // quarantine expecting a belated result for the abandoned turn. Feed it
  // one, exactly as the "interrupt() never returns" case does, so the
  // quarantine clears instead of swallowing the next turn's own result.
  sdk.emit({ type: 'result', subtype: 'error_during_execution' });
  await settle();

  // The session must still be usable afterwards, exactly as after a hung or
  // successful interrupt().
  const events = drain(session.send('ciao'));
  await settle();
  sdk.emit(textDelta('Ciao.'));
  sdk.emit(RESULT);
  assert.deepEqual(await events, [
    { type: 'text', delta: 'Ciao.' },
    { type: 'done' },
  ]);
  await session.close();
});

test('a warm-up give-up interrupts the CLI, so its belated stream events never reach the first real turn', async () => {
  // This is the exact bug the review caught: the give-up path armed the
  // stale-result quarantine and ended the turn locally, but never told the
  // CLI to stop working on the abandoned '.' turn. The quarantine only guards
  // the one `result` message a turn owes on its own — #emit() now also
  // checks it before appending anything to #turn, which is what actually
  // closes the gap for stream events too (spec: session.ts #emit). Without
  // the interrupt() call (and the drain that follows it, exactly as in
  // interrupt()), a content_block_start/text_delta belonging to the dead
  // warm-up turn would land directly in the user's first real turn and get
  // spoken. Crucially, the leaked events are emitted here only AFTER
  // send()'s real turn has already reassigned #turn — emitting them before
  // that would prove nothing, since #emit()'s plain "no current turn" check
  // would drop them regardless of whether the interrupt/quarantine path ran
  // at all.
  const sdk = makeFakeSdk();
  sdk.autoAnswerWarmUp = false; // the model never answers the throwaway '.' message
  sdk.resultOnInterrupt = false; // the interrupt is not acked immediately

  const fast = {
    ...config,
    director: { ...config.director, turnTimeoutMs: 50 },
  } as never;
  const session = new ClaudeAgentSession(fast, { startupFn: sdk.startupFn, interruptDrainMs: 80 });

  const starting = session.start();
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 60)); // past turnTimeoutMs: the warm-up gives up
  await settle();
  assert.equal(sdk.interrupts, 1, 'give-up must interrupt the CLI, exactly like a real interrupt() does');

  // Neither the interrupt nor a result arrives in time: the drain itself
  // times out, so the quarantine arms and start() resolves with the CLI
  // still owing output for the abandoned turn.
  await new Promise((resolve) => setTimeout(resolve, 120)); // past interruptDrainMs
  await settle();
  await starting; // start() only resolves once the doomed turn is given up on
  sdk.prompts.length = 0;

  // The real turn starts, reassigning #turn away from the abandoned one...
  const events = drain(session.send('ciao davvero'));
  await settle();

  // ...and only now, with #turn already the new real turn, does the CLI
  // belatedly stream its reply to the abandoned '.' turn and report it
  // ended. This is the actual race: nothing but the quarantine stops these
  // from being attributed to the turn that is now current.
  sdk.emit({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  });
  sdk.emit(textDelta('Ciao! Come posso aiutarti?')); // the leaked warm-up reply
  sdk.emit({ type: 'result', subtype: 'error_during_execution' }); // the belated warm-up result
  await settle();

  sdk.emit(textDelta('Risposta vera.'));
  sdk.emit(RESULT);

  const deltas = (await events).filter((e) => e.type === 'text').map((e) => e.delta);
  assert.deepEqual(
    deltas,
    ['Risposta vera.'],
    'the abandoned warm-up turn must never leak stream events into the first real turn, ' +
      'even after #turn has been reassigned',
  );
  await session.close();
});

test(
  'two overlapping ghost turns are each independently swallowed, neither bleeding into a third real turn',
  async () => {
    // The bug this guards against: #staleResult used to be a single
    // timer/slot, but two give-ups can each owe a ghost at once — here, the
    // warm-up's give-up owes R1, and a LATER turn's interrupt() give-up owes
    // R2 before R1's belated result has even landed. With a single shared
    // slot, consuming R1's result via #takeStaleResult cleared the whole
    // quarantine, so R2's still-outstanding belated tail would then leak
    // straight into whatever real turn (T3) had since started. #staleResults
    // is now a counter: consuming one ghost must only release ITS OWN slot,
    // leaving the other one armed.
    const sdk = makeFakeSdk();
    sdk.autoAnswerWarmUp = false; // the warm-up's throwaway message is never answered
    sdk.resultOnInterrupt = false; // no interrupt() ever auto-acks with a result

    const fast = {
      ...config,
      director: { ...config.director, turnTimeoutMs: 50 },
    } as never;
    const session = new ClaudeAgentSession(fast, {
      startupFn: sdk.startupFn,
      interruptDrainMs: 80,
      staleResultWindowMs: 5000, // must not fire mid-test
    });

    // --- Ghost #1: the warm-up gives up, owing R1's belated result. ---
    const starting = session.start();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 60)); // past turnTimeoutMs
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 120)); // past interruptDrainMs
    await settle();
    await starting; // start() resolves with R1 still owed
    sdk.prompts.length = 0;

    // --- A real turn (T2) starts, then is itself interrupted and gives up
    // in turn, owing a second ghost, R2 -- while R1 is STILL outstanding. ---
    const t2 = drain(session.send('seconda'));
    await settle();
    sdk.emit(textDelta("C'era una volta"));
    await settle();
    await session.interrupt(); // resultOnInterrupt is false: this too times out and gives up, owing R2
    await t2;

    // --- A third, genuinely new turn (T3) starts, reassigning #turn away
    // from both ghosts. ---
    const t3 = drain(session.send('terza'));
    await settle();

    // R1's belated tail lands first...
    sdk.emit(textDelta('R1 leaked'));
    sdk.emit({ type: 'result', subtype: 'error_during_execution' }); // R1's belated result
    await settle();

    // ...and only now does R2's belated tail land. With a single shared slot,
    // consuming R1's result above would already have cleared the whole
    // quarantine, letting this leak straight into T3.
    sdk.emit(textDelta('R2 leaked'));
    sdk.emit({ type: 'result', subtype: 'error_during_execution' }); // R2's belated result
    await settle();

    // T3's own, genuine reply.
    sdk.emit(textDelta('Risposta T3.'));
    sdk.emit(RESULT);

    const deltas = (await t3).filter((e) => e.type === 'text').map((e) => e.delta);
    assert.deepEqual(
      deltas,
      ['Risposta T3.'],
      'neither ghost (R1 nor R2) may leak into T3, even though R1 was consumed first',
    );
    await session.close();
  },
);

test(
  "a ghost's own timer firing after it was already consumed early must not phantom-release a sibling " +
    'ghost still genuinely owed',
  async () => {
    // Regression for the round-6 bug: #armStaleResult() scheduled an unref'd
    // setTimeout per ghost but never kept the handle, so #takeStaleResult()
    // consuming a ghost EARLY (before its own window elapsed) could not cancel
    // that ghost's timer. Left alive, the timer fired anyway later, calling
    // #releaseStaleResult() a SECOND time for a single ghost (A). If a second,
    // genuinely still-outstanding ghost (B) had been armed in the meantime,
    // that phantom decrement zeroed #staleResults early — restoring default
    // mode and, worse, meant #emit()/#dispatch no longer recognised B's own
    // still-owed belated tail as stale: its text deltas would leak into
    // whatever real turn (T3) was running concurrently, and its belated
    // `result` would be misattributed to T3 as a genuine failure (#dispatch's
    // `error_during_execution` branch). staleResultWindowMs is short (400ms,
    // unlike the 5000ms used elsewhere purely to test the counter arithmetic)
    // so A's timer actually gets a chance to fire mid-test.
    const sdk = makeFakeSdk();
    sdk.autoAnswerWarmUp = false; // the warm-up's throwaway message is never answered
    sdk.resultOnInterrupt = false; // no interrupt() ever auto-acks with a result

    const fast = {
      ...config,
      director: { ...config.director, turnTimeoutMs: 50 },
    } as never;
    const session = new ClaudeAgentSession(fast, {
      startupFn: sdk.startupFn,
      interruptDrainMs: 50,
      staleResultWindowMs: 400,
    });

    // --- Ghost A: the warm-up gives up, arming A's slot and starting A's own
    // 400ms timer. ---
    const starting = session.start();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 70)); // past turnTimeoutMs
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 70)); // past interruptDrainMs
    await settle();
    await starting; // start() resolves with A still owed
    sdk.prompts.length = 0;
    const armedAt = Date.now();
    assert.deepEqual(
      sdk.permissionModes,
      ['plan'],
      'the warm-up give-up must have entered plan mode and not yet exited it',
    );

    // --- A's belated result lands EARLY, well inside its own 400ms window,
    // consumed via #takeStaleResult. With the fix this cancels A's own timer
    // outright; with the bug, A's original setTimeout is still live regardless
    // and will fire again later on its own schedule. Since A was the only
    // ghost owed, consuming it also restores default mode immediately. ---
    sdk.emit({ type: 'result', subtype: 'error_during_execution' }); // A's belated result, consumed early
    await settle();
    assert.deepEqual(
      sdk.permissionModes,
      ['plan', 'default'],
      "consuming the only outstanding ghost (A) must restore default mode right away",
    );

    // A deliberate gap before B is armed: keeps B's own 400ms window (which
    // starts when IT is armed, below) comfortably separated in absolute time
    // from A's -- otherwise the margin needed to clear A's window risks
    // running past B's own and confusing a genuine, non-buggy expiry of B's
    // timer with the phantom release this test exists to catch.
    await new Promise((resolve) => setTimeout(resolve, 150));

    // --- Ghost B: a real turn (T2) starts, then is itself interrupted and
    // gives up in turn, arming a second slot -- comfortably before A's
    // original 400ms window has elapsed. ---
    const t2 = drain(session.send('seconda'));
    await settle();
    sdk.emit(textDelta("C'era una volta"));
    await settle();
    await session.interrupt(); // resultOnInterrupt is false: this too times out and arms B
    await t2;
    const armedAtB = Date.now(); // B's own 400ms window starts roughly here
    assert.ok(
      armedAtB - armedAt < 400,
      "test invariant: B must be armed before A's own original timer would fire",
    );
    assert.deepEqual(
      sdk.permissionModes,
      ['plan', 'default', 'plan'],
      'B being armed via interrupt() must re-enter plan mode',
    );

    // --- Wait just past A's original 400ms window (measured from armedAt),
    // but well short of B's OWN 400ms window (measured from armedAtB, which
    // is later than armedAt): the margin here must clear the first without
    // ever risking the second, or a genuine, non-buggy expiry of B's own
    // timer would land in the same gap and produce an indistinguishable
    // "default" entry. If A's timer was never cancelled (the bug), it fires
    // within this window and phantom-decrements the counter a second time for
    // A alone -- but only B is genuinely outstanding at this point, so that
    // phantom decrement would zero the counter early and restore default mode
    // well before B's own belated tail has arrived. ---
    const sinceA = armedAtB - armedAt;
    const waitMs = Math.max(0, 400 - sinceA) + 40;
    assert.ok(
      waitMs < 400 - 100,
      "test invariant: the wait must clear only A's window, not risk B's own 400ms window too",
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    assert.deepEqual(
      sdk.permissionModes,
      ['plan', 'default', 'plan'],
      "A's timer firing after its own early consumption must not release B's still-outstanding slot " +
        '(a fourth, premature "default" entry here would be exactly that bug)',
    );

    // --- A genuinely new turn (T3) starts while B is still owed, reassigning
    // #turn away from it. send() itself proactively exits plan mode for any
    // new turn regardless of the stale-result counter (see send()'s own
    // comment) -- that is unrelated to this bug and expected either way. ---
    const t3 = drain(session.send('terza'));
    await settle();

    // B's belated tail lands now -- must still be swallowed by the (still
    // outstanding, un-corrupted) counter, not leaked into T3.
    sdk.emit(textDelta('B leaked'));
    sdk.emit({ type: 'result', subtype: 'error_during_execution' }); // B's belated result
    await settle();

    // T3's own, genuine reply.
    sdk.emit(textDelta('Risposta T3.'));
    sdk.emit(RESULT);

    const deltas = (await t3).filter((e) => e.type === 'text').map((e) => e.delta);
    assert.deepEqual(
      deltas,
      ['Risposta T3.'],
      "B's belated tail must never leak into T3, even after A's own timer fired in the background",
    );
    await session.close();
  },
);

// --- Tool suppression during a give-up --------------------------------------
//
// WebSearch/WebFetch/ToolSearch sit in allowedTools (spec §8/buildOptions),
// which means they skip canUseTool entirely, and a real in-flight HTTP call
// cannot be reliably stopped by interrupt(). Layered on top of the explicit
// WARM_UP_MESSAGE instruction not to use any tool: 'plan' mode
// (#enterPlanMode/#exitPlanMode) and, backing it up, a PreToolUse hook
// (#denyToolsWhileSuppressed) that the SDK's own docs recommend as the one
// gate that runs before every tool call regardless of allowedTools.

test('warm-up enters plan mode before the throwaway message and exits once it settles normally', async () => {
  const sdk = makeFakeSdk();
  const session = new ClaudeAgentSession(config, { startupFn: sdk.startupFn });
  await session.start();
  await settle();

  assert.deepEqual(sdk.prompts, [WARM_UP_MESSAGE]);
  assert.deepEqual(
    sdk.permissionModes,
    ['plan', 'default'],
    'plan mode must be entered before the message is pushed and exited once the turn settles',
  );
  await session.close();
});

test(
  'a warm-up that never gets a result keeps tool suppression armed, but the quarantine window itself ' +
    'eventually restores default mode',
  async () => {
    const sdk = makeFakeSdk();
    sdk.autoAnswerWarmUp = false; // the model never answers the throwaway message
    sdk.resultOnInterrupt = false; // ...and no result for the abandoned turn ever arrives, period

    const fast = {
      ...config,
      director: { ...config.director, turnTimeoutMs: 30, interruptTimeoutMs: 30 },
    } as never;
    const session = new ClaudeAgentSession(fast, {
      startupFn: sdk.startupFn,
      interruptDrainMs: 30,
      staleResultWindowMs: 60,
    });

    await session.start();
    assert.deepEqual(
      sdk.permissionModes,
      ['plan'],
      'neither interrupt() nor the drain confirmed completion, so suppression must stay armed',
    );

    const decision = getPreToolUseDecision(sdk);
    const denied = (await decision()) as { hookSpecificOutput?: { permissionDecision?: string } };
    assert.equal(denied.hookSpecificOutput?.permissionDecision, 'deny', 'a tool call mid give-up must be refused');

    // Real margin past staleResultWindowMs: no belated result ever arrives at all.
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(
      sdk.permissionModes,
      ['plan', 'default'],
      "the quarantine timer's own expiry must restore default mode even with nothing to react to",
    );
    const allowed = (await decision()) as { hookSpecificOutput?: unknown };
    assert.equal(allowed.hookSpecificOutput, undefined, 'the hook must allow again once suppression clears');

    await session.close();
  },
);

test('interrupt() enters plan mode and exits promptly once the killed turn is confirmed done', async () => {
  const sdk = makeFakeSdk();
  const session = await startSession(sdk);
  const events = drain(session.send('racconta'));
  await settle();
  sdk.emit(textDelta("C'era una volta"));
  await settle();

  await session.interrupt();
  assert.deepEqual(
    sdk.permissionModes,
    ['plan', 'default'],
    'a confirmed interrupt must restore default mode promptly, not wait out the full quarantine window',
  );
  await events;
  await session.close();
});

test(
  "interrupt() whose drain never confirms completion leaves suppression armed until the quarantine " +
    'window elapses',
  async () => {
    const sdk = makeFakeSdk();
    sdk.resultOnInterrupt = false; // the CLI never acks the interrupt with a result
    const session = await startSession(sdk, { interruptDrainMs: 30, staleResultWindowMs: 60 });

    const events = drain(session.send('racconta'));
    await settle();
    sdk.emit(textDelta("C'era una volta"));
    await settle();

    await session.interrupt();
    assert.deepEqual(
      sdk.permissionModes,
      ['plan'],
      'no result ever confirmed the killed turn was done, so suppression must stay armed',
    );
    await events; // #endTurn ended the turn locally even though no result ever came

    await new Promise((resolve) => setTimeout(resolve, 120)); // past staleResultWindowMs, with margin
    assert.deepEqual(sdk.permissionModes, ['plan', 'default'], 'the quarantine window itself must restore default mode');

    await session.close();
  },
);

test('the PreToolUse hook allows an ordinary tool call when nothing is suppressed', async () => {
  const sdk = makeFakeSdk();
  const session = await startSession(sdk);

  const decision = getPreToolUseDecision(sdk);
  const result = (await decision()) as { hookSpecificOutput?: unknown };
  assert.equal(result.hookSpecificOutput, undefined, 'a tool call outside any give-up must not be touched');
  await session.close();
});

test('a completely ordinary turn causes no setPermissionMode calls at all', async () => {
  const sdk = makeFakeSdk();
  const session = await startSession(sdk); // resets sdk.permissionModes past the warm-up's own plan/default pair
  const events = drain(session.send('ciao'));
  await settle();
  sdk.emit(textDelta('Ciao.'));
  sdk.emit(RESULT);
  await events;

  assert.deepEqual(
    sdk.permissionModes,
    [],
    'a turn that neither warms up nor gives up must never touch permission mode',
  );
  await session.close();
});

test("send() clears a stale quarantine's tool suppression instead of holding the new turn hostage to it", async () => {
  // Deliberately does not drive the new turn to a result: the abandoned
  // warm-up turn's own belated result never arrives either (by construction,
  // to keep #suppressTools armed well past send()), and #staleResult's own
  // "single ordered stream" invariant (spec: session.ts STALE_RESULT_WINDOW_MS)
  // means a result that never comes is a separate, already-accepted hazard of
  // the quarantine timer itself — not something send()'s defensive
  // suppressTools check claims to fix. This test is only about that one
  // check: tool suppression must not survive into a turn that has already
  // started.
  const sdk = makeFakeSdk();
  sdk.autoAnswerWarmUp = false; // the model never answers the throwaway warm-up message
  sdk.resultOnInterrupt = false; // and the interrupt that follows is never acked either

  const fast = {
    ...config,
    director: { ...config.director, turnTimeoutMs: 30, interruptTimeoutMs: 30 },
  } as never;
  const session = new ClaudeAgentSession(fast, {
    startupFn: sdk.startupFn,
    interruptDrainMs: 30,
    staleResultWindowMs: 5000, // must not fire during this test
  });
  await session.start();
  assert.deepEqual(
    sdk.permissionModes,
    ['plan'],
    'the give-up path must leave suppression armed, waiting on a quarantine that will not expire in time',
  );

  const decision = getPreToolUseDecision(sdk);
  const deniedBefore = (await decision()) as { hookSpecificOutput?: { permissionDecision?: string } };
  assert.equal(deniedBefore.hookSpecificOutput?.permissionDecision, 'deny', 'suppression must be armed before send()');

  void drain(session.send('ciao davvero')).catch(() => {});
  await settle();
  assert.deepEqual(
    sdk.permissionModes,
    ['plan', 'default'],
    "send()'s own defensive check must clear a stale quarantine's suppression rather than wait out its window",
  );
  const allowedAfter = (await decision()) as { hookSpecificOutput?: unknown };
  assert.equal(
    allowedAfter.hookSpecificOutput,
    undefined,
    'a legitimate new turn must not be silently held in no-tool-execution mode',
  );

  await session.close();
});

// --- One long-lived session ------------------------------------------------

test('the first turn is not lost to the input stream being slow to start', async () => {
  const sdk = makeFakeSdk();
  const session = await startSession(sdk);
  const events = drain(session.send('primo turno'));
  await settle();
  sdk.emit(RESULT);
  await events;
  assert.deepEqual(sdk.prompts, ['primo turno']);
  await session.close();
});

test('a second turn reuses the same query: finishing a turn must not close the session', async () => {
  // The obvious `for await (const m of query)` closes the generator on return,
  // which tears the session down and puts the 7 s startup back on turn 2.
  const sdk = makeFakeSdk();
  const session = await startSession(sdk);

  const first = drain(session.send('uno'));
  await settle();
  sdk.emit(textDelta('Uno.'));
  sdk.emit(RESULT);
  await first;

  assert.equal(sdk.returns, 0, 'the long-lived query must still be open');

  const second = drain(session.send('due'));
  await settle();
  sdk.emit(textDelta('Due.'));
  sdk.emit(RESULT);
  const events = await second;

  assert.deepEqual(
    events.filter((e) => e.type === 'text').map((e) => e.delta),
    ['Due.'],
    'turn 2 must not replay turn 1',
  );
  assert.deepEqual(sdk.prompts, ['uno', 'due']);
  await session.close();
});

test('a transport failure surfaces on the turn instead of hanging it', async () => {
  const sdk = makeFakeSdk();
  const session = await startSession(sdk);
  const events = drain(session.send('ciao'));
  await settle();
  sdk.fail(new Error('CLI exited'));
  await assert.rejects(() => events, /CLI exited/, 'a silent agent is indistinguishable from a thinking one');
});

// --- Interruption ----------------------------------------------------------

test('interrupt() interrupts and never tears the session down', async () => {
  const sdk = makeFakeSdk();
  const session = await startSession(sdk);
  const events = drain(session.send('raccontami una storia'));
  await settle();
  sdk.emit(textDelta("C'era una volta"));
  await settle();

  await session.interrupt();

  assert.equal(sdk.interrupts, 1);
  assert.equal(sdk.returns, 0, 'abort tears the session down and costs ~2 s to rebuild (spec §6)');
  await events;
  await session.close();
});

test('abandoning the event stream mid-turn leaves the session usable', async () => {
  // Barge-in: the Director stops consuming the moment the user speaks.
  const sdk = makeFakeSdk();
  const session = await startSession(sdk);

  const stream = session.send('raccontami una storia');
  const heard: string[] = [];
  await settle();
  sdk.emit(textDelta("C'era una volta un re"));
  for await (const event of stream) {
    if (event.type === 'text') heard.push(event.delta);
    break; // user started talking
  }

  await session.interrupt();
  assert.equal(sdk.returns, 0, 'the query survives the consumer walking away');

  const next = drain(session.send('aspetta'));
  await settle();
  sdk.emit(textDelta('Dimmi.'));
  sdk.emit(RESULT);
  assert.deepEqual(
    (await next).filter((e) => e.type === 'text').map((e) => e.delta),
    ['Dimmi.'],
    'the interrupted turn must not bleed into the next one',
  );
  await session.close();
});

test('interrupt() drains the interrupted turn before returning', async () => {
  const sdk = makeFakeSdk();
  const session = await startSession(sdk);
  const events = drain(session.send('storia'));
  await settle();
  sdk.emit(textDelta('Tanto tempo fa'));
  await settle();

  await session.interrupt();
  // The turn's own result was consumed by the drain, so the next turn starts clean.
  const settled = await events;
  assert.equal(settled.at(-1)?.type, 'done', 'the interrupted turn must be closed off');
  await session.close();
});

test('interrupt() gives up draining rather than blocking barge-in forever', async () => {
  const sdk = makeFakeSdk();
  sdk.resultOnInterrupt = false; // a CLI that never acknowledges
  const session = await startSession(sdk, { interruptDrainMs: 50 });
  void drain(session.send('storia')).catch(() => {});
  await settle();
  sdk.emit(textDelta('Tanto tempo fa'));
  await settle();

  const started = Date.now();
  await session.interrupt();
  assert.ok(Date.now() - started < 500, 'the microphone is already open; nothing may block here');
  await session.close();
});

test('a hung query.interrupt() does not block the public interrupt() forever', async () => {
  // Mirrors "a warm-up whose interrupt() itself never returns..." above, but
  // for the public interrupt() method the Director actually calls. The
  // Director's own #interrupt() wrapper (director.ts) races a timer against
  // THIS whole method and gives up after interruptTimeoutMs — but giving up
  // there does nothing for a raw query.interrupt() call still hung inside
  // this method's own Promise.all. Left unbounded, this method would still
  // be awaiting it long after the Director moved on, with #turn still
  // pointing at the turn this call was supposed to retire — so the
  // abandoned turn's belated result/events would never be quarantined and
  // would leak into whatever new turn the Director started next.
  const sdk = makeFakeSdk();
  sdk.hangInterrupt = true; // query.interrupt() itself never resolves
  const session = await startSession(sdk, { interruptDrainMs: 50, interruptTimeoutMs: 80 });
  const events = drain(session.send('raccontami una storia'));
  await settle();
  sdk.emit(textDelta("C'era una volta"));
  await settle();

  const started = Date.now();
  await session.interrupt();
  assert.ok(Date.now() - started < 1000, 'a hung query.interrupt() must not block interrupt() forever');
  sdk.releaseInterrupts(); // it does eventually come back, just not within budget

  // The abandoned turn's belated result must still be quarantined, exactly
  // as it is when interrupt() itself returns promptly.
  sdk.emit({ type: 'result', subtype: 'error_during_execution' });
  await settle();
  await events;

  const next = drain(session.send('aspetta'));
  await settle();
  sdk.emit(textDelta('Dimmi.'));
  sdk.emit(RESULT);
  assert.deepEqual(
    (await next).filter((e) => e.type === 'text').map((e) => e.delta),
    ['Dimmi.'],
    "the abandoned turn's belated result must never leak into the next turn",
  );
  await session.close();
});

test('a public interrupt() whose query.interrupt() rejects still resolves instead of throwing', async () => {
  // Mirrors the warm-up "interrupt() rejects" case above, but exercises the
  // public interrupt() method directly: every other call into the SDK's
  // control protocol in this file (#enterPlanMode, #exitPlanMode, #warmUp's
  // give-up path) is wrapped in .catch(() => undefined). interrupt() itself
  // was the one exception — a real, already-tested failure mode
  // ("control request failed: session not initialized") would reject the
  // Promise.all it sits in, and every caller in director.ts either doesn't
  // catch it or awaits it unguarded, so this surfaced as an unhandled
  // rejection that took the whole process down via cli.ts's global handler.
  const sdk = makeFakeSdk();
  sdk.rejectInterrupt = true; // interrupt() rejects instead of hanging or resolving
  const session = await startSession(sdk);

  const events = drain(session.send('raccontami una storia'));
  await settle();
  sdk.emit(textDelta("C'era una volta"));
  await settle();

  await assert.doesNotReject(
    () => session.interrupt(),
    'a rejecting query.interrupt() must not propagate out of the public interrupt()',
  );
  assert.equal(sdk.interrupts, 1);

  // interrupt() rejected before it could emit the cut turn's own result, so
  // the drain also times out and the give-up path arms the stale-result
  // quarantine. Feed it the belated result so the quarantine clears rather
  // than swallowing the next turn.
  sdk.emit({ type: 'result', subtype: 'error_during_execution' });
  await settle();
  await events;

  // The session must still be usable afterwards.
  const next = drain(session.send('ciao'));
  await settle();
  sdk.emit(textDelta('Ciao.'));
  sdk.emit(RESULT);
  assert.deepEqual(await next, [
    { type: 'text', delta: 'Ciao.' },
    { type: 'done' },
  ]);
  await session.close();
});

test('interrupt() with no turn in flight is harmless', async () => {
  const sdk = makeFakeSdk();
  const session = await startSession(sdk);
  await session.interrupt();
  assert.equal(sdk.interrupts, 1);
  await session.close();
});

test('the next turn tells Claude what the user actually heard', async () => {
  const sdk = makeFakeSdk();
  const session = await startSession(sdk);
  session.notifyInterruption("C'era una volta un re", 'aspetta, cambia argomento');

  const events = drain(session.send('aspetta, cambia argomento'));
  await settle();
  sdk.emit(RESULT);
  await events;

  const prompt = sdk.prompts[0] ?? '';
  assert.match(prompt, /C'era una volta un re/, 'the heard prefix is the shared context');
  assert.match(prompt, /aspetta, cambia argomento/);
  assert.notEqual(prompt, 'aspetta, cambia argomento', 'the note must be prepended');
  await session.close();
});

test('the interruption note is used once, not on every later turn', async () => {
  const sdk = makeFakeSdk();
  const session = await startSession(sdk);
  session.notifyInterruption('mezza frase', 'aspetta');

  const first = drain(session.send('aspetta'));
  await settle();
  sdk.emit(RESULT);
  await first;

  const second = drain(session.send('vai avanti'));
  await settle();
  sdk.emit(RESULT);
  await second;

  assert.equal(sdk.prompts[1], 'vai avanti', 'a stale note would rewrite history every turn');
  await session.close();
});

// --- Permissions -----------------------------------------------------------

test('a permission request without a handler is denied, not left hanging', async () => {
  const options = buildOptions(config);
  const result = await options.canUseTool!('Write', { file_path: '/tmp/x' }, {
    signal: new AbortController().signal,
    toolUseID: 't1',
    requestId: 'r1',
  } as never);
  assert.equal(result!.behavior, 'deny');
});

test('an unanswered permission request times out into a denial', async () => {
  const fast = { ...config, director: { ...config.director, approvalTimeoutMs: 50 } };
  const session = new ClaudeAgentSession(fast as never);
  session.onPermissionRequest(() => new Promise<boolean>(() => {})); // never resolves

  const started = Date.now();
  const result = await session.handlePermission({ tool: 'Write', summary: 'scrivere su x' });
  assert.equal(result, false, 'the SDK callback has no deadline of its own (spec §8)');
  assert.ok(Date.now() - started < 500, 'must not wait forever');
});

test('a yes that arrives after the deadline is still a no', async () => {
  const fast = { ...config, director: { ...config.director, approvalTimeoutMs: 30 } };
  const session = new ClaudeAgentSession(fast as never);
  session.onPermissionRequest(
    () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 200)),
  );
  assert.equal(await session.handlePermission({ tool: 'Bash', summary: 'lanciare i test' }), false);
});

test('a handler that throws denies instead of crashing the turn', async () => {
  const session = new ClaudeAgentSession(config);
  session.onPermissionRequest(async () => {
    throw new Error('the transcriber died mid-question');
  });
  assert.equal(await session.handlePermission({ tool: 'Write', summary: 'scrivere' }), false);
});

test('a spoken yes allows the call with its input untouched', async () => {
  const sdk = makeFakeSdk();
  const session = await startSession(sdk);
  session.onPermissionRequest(async () => true);

  const canUseTool = sdk.options?.canUseTool as (
    tool: string,
    input: Record<string, unknown>,
    opts: unknown,
  ) => Promise<{ behavior: string; updatedInput?: Record<string, unknown>; message?: string }>;

  const input = { file_path: '/tmp/x', content: 'ciao' };
  const allowed = await canUseTool('Write', input, { title: 'Claude wants to write x' });
  assert.equal(allowed.behavior, 'allow');
  assert.deepEqual(allowed.updatedInput, input, 'the session must not rewrite the call');
  await session.close();
});

test('a spoken no denies with a reason Claude can adapt to', async () => {
  const sdk = makeFakeSdk();
  const session = await startSession(sdk);
  session.onPermissionRequest(async () => false);

  const canUseTool = sdk.options?.canUseTool as (
    tool: string,
    input: Record<string, unknown>,
    opts: unknown,
  ) => Promise<{ behavior: string; message?: string }>;

  const denied = await canUseTool('Bash', { command: 'rm -rf /' }, { title: 'Claude wants to run rm' });
  assert.equal(denied.behavior, 'deny');
  assert.ok(denied.message, 'the denial reason goes back to Claude (spec §8)');
  await session.close();
});

test("the request carries the SDK's own sentence, so it reads back sensibly", async () => {
  const sdk = makeFakeSdk();
  const session = await startSession(sdk);
  const seen: { tool: string; summary: string }[] = [];
  session.onPermissionRequest(async (req) => {
    seen.push({ ...req });
    return false;
  });

  const canUseTool = sdk.options?.canUseTool as (
    tool: string,
    input: Record<string, unknown>,
    opts: unknown,
  ) => Promise<unknown>;

  await canUseTool('Write', {}, { title: 'Claude wants to write session.ts' });
  await canUseTool('Edit', {}, {}); // older CLIs send no title
  assert.deepEqual(seen[0], { tool: 'Write', summary: 'Claude wants to write session.ts' });
  assert.equal(seen[1]?.tool, 'Edit');
  assert.match(seen[1]?.summary ?? '', /Edit/, 'a missing title must still produce a speakable line');
  await session.close();
});

test('approval is per call and never remembered', async () => {
  const sdk = makeFakeSdk();
  const session = await startSession(sdk);
  let asked = 0;
  session.onPermissionRequest(async () => {
    asked += 1;
    return true;
  });

  const canUseTool = sdk.options?.canUseTool as (
    tool: string,
    input: Record<string, unknown>,
    opts: unknown,
  ) => Promise<unknown>;

  await canUseTool('Write', { file_path: '/tmp/a' }, {});
  await canUseTool('Write', { file_path: '/tmp/b' }, {});
  assert.equal(asked, 2, 'the user cannot see what they would agree to for the rest of the session');
  await session.close();
});

test('a read-only tool reaching the callback is asked about, not assumed impossible', async () => {
  // allowedTools suppresses the callback for most read-only calls, but a few
  // sensitive actions reach it regardless (spec §8).
  const sdk = makeFakeSdk();
  const session = await startSession(sdk);
  let asked = false;
  session.onPermissionRequest(async () => {
    asked = true;
    return true;
  });

  const canUseTool = sdk.options?.canUseTool as (
    tool: string,
    input: Record<string, unknown>,
    opts: unknown,
  ) => Promise<{ behavior: string }>;

  const result = await canUseTool('WebFetch', { url: 'https://example.com' }, {});
  assert.ok(asked, 'a pre-approved tool can still prompt');
  assert.equal(result.behavior, 'allow');
  await session.close();
});

test('dispatching a subagent is auto-approved without a spoken yes', async () => {
  // 'Agent' is the SDK's real tool name for a subagent dispatch (sdk.d.ts:
  // Options.agents docs, "invoked via the Agent tool"). Dispatch alone is
  // inert; whatever the subagent's own tools go on to do still hits this
  // same canUseTool individually (see the comment in session.ts).
  const sdk = makeFakeSdk();
  const session = await startSession(sdk);
  let asked = false;
  session.onPermissionRequest(async () => {
    asked = true;
    return false; // even a spoken "no" must not matter: handlePermission must not run at all
  });

  const canUseTool = sdk.options?.canUseTool as (
    tool: string,
    input: Record<string, unknown>,
    opts: unknown,
  ) => Promise<{ behavior: string; updatedInput?: Record<string, unknown> }>;

  const input = { description: 'Search jobs', prompt: 'cerca web3 developer jobs', subagent_type: 'job-hunter' };
  const result = await canUseTool('Agent', input, {});
  assert.equal(result.behavior, 'allow');
  assert.deepEqual(result.updatedInput, input, 'the dispatch call must not be rewritten');
  assert.equal(asked, false, 'the approval flow must be skipped entirely, not answered');
  await session.close();
});

test('a subagent dispatch still leaves its own tool calls gated', async () => {
  // Approving the dispatch must not become a blanket approval: a Write call
  // the subagent itself makes is a distinct canUseTool invocation and still
  // needs a spoken yes.
  const sdk = makeFakeSdk();
  const session = await startSession(sdk);
  let asked = 0;
  session.onPermissionRequest(async () => {
    asked += 1;
    return true;
  });

  const canUseTool = sdk.options?.canUseTool as (
    tool: string,
    input: Record<string, unknown>,
    opts: unknown,
  ) => Promise<{ behavior: string }>;

  const dispatch = await canUseTool('Agent', { description: 'x', prompt: 'y', subagent_type: 'general-purpose' }, {});
  const write = await canUseTool('Write', { file_path: '/tmp/x' }, {});
  assert.equal(dispatch.behavior, 'allow');
  assert.equal(write.behavior, 'allow');
  assert.equal(asked, 1, 'only the Write call goes through the spoken-approval flow');
  await session.close();
});

// --- Debug -------------------------------------------------------------------

test('the injected debug callback wires up the SDK stderr option and traces the pipeline', async () => {
  const sdk = makeFakeSdk();
  const lines: string[] = [];
  const session = new ClaudeAgentSession(config, {
    startupFn: sdk.startupFn,
    debug: (message) => lines.push(message),
  });
  await session.start();
  await settle();

  // The SDK's own stderr callback (sdk.d.ts Options.stderr) must be wired to
  // the same injected debug callback, not left unset.
  const stderr = sdk.options?.stderr as ((data: string) => void) | undefined;
  assert.equal(typeof stderr, 'function');
  stderr?.('some cli stderr output');
  assert.ok(lines.some((line) => line.includes('cli stderr: some cli stderr output')));

  // The turn pipeline traced at least start-up and warm-up.
  assert.ok(lines.some((line) => line.includes('starting claude CLI subprocess')));
  assert.ok(lines.some((line) => line.includes('warm-up starting')));

  lines.length = 0;
  // Only start consuming: the generator body runs up to its first await/yield
  // on the first next() call, which is enough to see the entry log fire.
  const iterator = session.send('ciao')[Symbol.asyncIterator]();
  const pending = iterator.next();
  await settle();
  assert.ok(lines.some((line) => line.includes('send() called, pushing turn')));

  sdk.emit(RESULT);
  await pending;
  await session.close();
});

test('with no debug callback injected, nothing is logged (no-op by default)', async () => {
  const sdk = makeFakeSdk();
  // No debug option passed at all — mirrors production with AXA_DEBUG unset.
  const session = new ClaudeAgentSession(config, { startupFn: sdk.startupFn });
  await session.start();
  await settle();
  const stderr = sdk.options?.stderr as ((data: string) => void) | undefined;
  // Must not throw even though nothing is listening.
  assert.doesNotThrow(() => stderr?.('noise'));
  await session.close();
});

// --- Live ------------------------------------------------------------------

test(
  'live: first token on turn N stays under the 1500 ms sanity ceiling',
  { skip: process.env.AXA_LIVE ? false : 'set AXA_LIVE=1 to spend money on a real session' },
  async () => {
    const session = new ClaudeAgentSession(loadConfig({ CARTESIA_API_KEY: 'sk_test' }));
    const t0 = Date.now();
    await session.start();
    console.log(`prewarm: ${Date.now() - t0} ms`);

    const firstTokens: number[] = [];
    for (const question of ["Di' solo: uno.", "Di' solo: due.", "Di' solo: tre."]) {
      const askedAt = Date.now();
      let ttft: number | undefined;
      for await (const event of session.send(question)) {
        if (event.type === 'text' && event.delta.trim() && ttft === undefined) {
          ttft = Date.now() - askedAt;
        }
      }
      firstTokens.push(ttft ?? Number.NaN);
    }
    await session.close();

    console.log(`first token per turn: ${firstTokens.join(' / ')} ms`);
    // Turn 1 pays for startup and is discarded: asserting on it measures the
    // launch cost and reports seconds (spec §4). The ceiling here is a sanity
    // check, not the 800 ms budget — the service's own variance is wide enough
    // that a tighter bound would send someone optimising nothing.
    for (const ms of firstTokens.slice(1)) {
      assert.ok(ms < 1500, `turn N first token was ${ms} ms`);
    }
  },
);
