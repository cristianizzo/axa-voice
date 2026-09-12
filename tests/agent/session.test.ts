import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOptions, ClaudeAgentSession } from '../../src/agent/session.ts';
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
  /** Text the session actually handed to Claude, in order. */
  prompts: string[];
  /** Options the session passed to startup(). */
  options: Record<string, unknown> | undefined;
  interrupts: number;
  /** Non-zero means the long-lived query was torn down. */
  returns: number;
  /** Emitted automatically when interrupt() is called, unless disabled. */
  resultOnInterrupt: boolean;
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
  };

  const wake = (): void => {
    notify?.();
    notify = undefined;
  };
  const emit = (message: unknown): void => {
    queued.push(message);
    wake();
  };

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
      // The real CLI ends the interrupted turn with a result message.
      if (state.resultOnInterrupt) emit({ type: 'result', subtype: 'error_during_execution' });
      return undefined;
    },
  };

  const startupFn = async (params: { options?: Record<string, unknown> }) => {
    state.options = params.options;
    return {
      query(prompt: AsyncIterable<{ message: { content: string } }>) {
        void (async () => {
          for await (const turn of prompt) state.prompts.push(turn.message.content);
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
  };
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
  overrides: Partial<{ approvalTimeoutMs: number; interruptDrainMs: number }> = {},
): Promise<ClaudeAgentSession> {
  const cfg = overrides.approvalTimeoutMs
    ? ({ ...config, director: { ...config.director, approvalTimeoutMs: overrides.approvalTimeoutMs } } as never)
    : config;
  const session = new ClaudeAgentSession(cfg, {
    startupFn: sdk.startupFn,
    interruptDrainMs: overrides.interruptDrainMs,
  });
  await session.start();
  await settle();
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
  const session = new ClaudeAgentSession(config, {
    startupFn: (async () => ({
      query: () =>
        (async function* () {
          yield {
            type: 'stream_event',
            event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Ciao' } },
          };
          yield {
            type: 'stream_event',
            event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' mondo' } },
          };
          yield { type: 'result' };
        })(),
      close: () => {},
    })) as never,
  });
  await session.start();

  const deltas: string[] = [];
  for await (const event of session.send('ciao')) {
    if (event.type === 'text') deltas.push(event.delta);
  }
  assert.deepEqual(deltas, ['Ciao', ' mondo']);
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

test('send() before start() is an error, not a silent no-op', () => {
  const session = new ClaudeAgentSession(config, { startupFn: makeFakeSdk().startupFn });
  assert.rejects(
    () => drain(session.send('ciao')),
    /start\(\)/,
    'a dropped turn is invisible in voice',
  );
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
