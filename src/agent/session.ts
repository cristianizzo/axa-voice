import { startup, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, AgentSession, PermissionRequest } from '../types.ts';
import type { Config } from '../config.ts';

const SPOKEN_STYLE = `
Stai parlando a voce, non scrivendo. Frasi brevi, tono naturale, niente elenchi puntati.
Non leggere mai codice ad alta voce: scrivilo e dì "te l'ho scritta".
Accorcia i percorsi dei file. Gli strumenti che hai sono veri: usali davvero.
`.trim();

/**
 * How long interrupt() waits for the CLI to close off the turn it just killed.
 * Bounded because the microphone is already open when this runs: a barge-in
 * that blocks is worse than a turn whose tail is dropped.
 */
const INTERRUPT_DRAIN_MS = 2000;
const CLOSE_TIMEOUT_MS = 2000;

export function buildOptions(config: Config): Options {
  return {
    model: 'sonnet',
    includePartialMessages: true,
    // All three are required. strictMcpConfig ignores project/user/plugin MCP
    // config; mcpServers leaves nothing to connect; settingSources must be
    // explicit because its default loads everything (spec §12). Measured: with
    // the user's MCP servers connected a turn costs 5-7 s more.
    strictMcpConfig: true,
    mcpServers: {},
    settingSources: ['user'],
    // Read-only tools never prompt: their worst case is wasted time and the
    // user is present and listening (spec §8). The SDK warns that bare names
    // here auto-approve BEFORE canUseTool runs, so the callback is shadowed for
    // exactly these — which is the intent. The Director must still handle a
    // permission request for a read-only tool rather than assert it cannot happen.
    allowedTools: [...config.readOnlyTools],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: SPOKEN_STYLE },
    canUseTool: async () => ({
      behavior: 'deny',
      message: 'No spoken-confirmation handler is attached.',
    }),
  };
}

/** The subset of the Anthropic streaming event shape this module reads. */
interface StreamEvent {
  type: string;
  index?: number;
  content_block?: { type: string; id?: string; name?: string };
  delta?: { type: string; text?: string };
}

interface Turn {
  events: AgentEvent[];
  wake: (() => void) | undefined;
  ended: boolean;
  error: unknown;
  settled: Promise<void>;
  markSettled: () => void;
}

function createTurn(): Turn {
  let markSettled = (): void => {};
  const settled = new Promise<void>((resolve) => {
    markSettled = resolve;
  });
  return { events: [], wake: undefined, ended: false, error: undefined, settled, markSettled };
}

/**
 * The open input stream that makes this ONE session instead of one process per
 * turn (7-10 s vs 0.8 s to first token). Turns are queued rather than handed to
 * a waiting resolver, because the SDK does not pull the first message until
 * well after start() returns and the first turn would otherwise be dropped.
 */
function makeInputStream(): {
  stream: AsyncGenerator<SDKUserMessage>;
  push: (text: string) => void;
  end: () => void;
} {
  const pending: string[] = [];
  let wake: (() => void) | undefined;
  let ended = false;

  const ping = (): void => {
    wake?.();
    wake = undefined;
  };

  async function* generate(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (pending.length === 0 && !ended) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      const text = pending.shift();
      if (text === undefined) return;
      yield {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      };
    }
  }

  return {
    stream: generate(),
    push(text: string) {
      pending.push(text);
      ping();
    },
    end() {
      ended = true;
      ping();
    },
  };
}

/**
 * Resolves with the promise, or gives up after `ms`. The timer is always
 * cleared: a guard timer left pending would keep the process alive for its
 * whole duration after the work it guarded finished.
 */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export class ClaudeAgentSession implements AgentSession {
  readonly #config: Config;
  readonly #startupFn: typeof startup;
  readonly #interruptDrainMs: number;
  readonly #closeTimeoutMs: number;

  #query: Query | undefined;
  #input = makeInputStream();
  #pumpDone: Promise<void> = Promise.resolve();
  #handler: ((req: PermissionRequest) => Promise<boolean>) | undefined;
  #pendingNote: string | undefined;

  /** The turn currently being consumed, if any. Messages outside one are dropped. */
  #turn: Turn | undefined;
  /** Content-block index -> what kind of block it is, for this turn. */
  #blocks = new Map<number, { kind: 'text' | 'tool'; id?: string }>();
  /** tool_use id -> tool name, so a tool_result can close the bracket. */
  #toolNames = new Map<string, string>();

  constructor(
    config: Config,
    opts: { startupFn?: typeof startup; interruptDrainMs?: number; closeTimeoutMs?: number } = {},
  ) {
    this.#config = config;
    this.#startupFn = opts.startupFn ?? startup;
    this.#interruptDrainMs = opts.interruptDrainMs ?? INTERRUPT_DRAIN_MS;
    this.#closeTimeoutMs = opts.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
  }

  /** Pre-warms the subprocess (~900 ms) so turn 1 does not pay for it. */
  async start(): Promise<void> {
    const options: Options = {
      ...buildOptions(this.#config),
      canUseTool: async (toolName, input, opts) => {
        // The bridge already renders a sentence that reads back sensibly; a
        // reconstruction from tool name plus raw input does not (spec §8).
        const title = (opts as { title?: string }).title;
        const allowed = await this.handlePermission({
          tool: toolName,
          summary: title ?? `Claude vuole usare ${toolName}`,
        });
        return allowed
          ? { behavior: 'allow' as const, updatedInput: input }
          : { behavior: 'deny' as const, message: "L'utente non ha confermato a voce." };
      },
    };

    const warm = await this.#startupFn({ options });
    const query = warm.query(this.#input.stream);
    this.#query = query;
    this.#pumpDone = this.#pump(query);
  }

  /**
   * Reads the session for its whole life. Never `for await`: returning out of
   * one calls `.return()` on the query, which tears the session down and puts
   * the startup cost back on the next turn (spec §4).
   */
  async #pump(query: Query): Promise<void> {
    try {
      for (;;) {
        const next = await query.next();
        if (next.done) break;
        this.#dispatch(next.value);
      }
      this.#failTurn(new Error('The Claude session ended.'));
    } catch (error) {
      this.#failTurn(error);
    }
  }

  #dispatch(message: SDKMessage): void {
    if (message.type === 'stream_event') {
      // Deltas exist for the main session only; anything with a parent is a
      // subagent sidechain and must not be spoken as the answer (spec §12).
      if (message.parent_tool_use_id) return;
      this.#onStreamEvent(message.event as StreamEvent);
      return;
    }

    if (message.type === 'user') {
      const content = message.message.content;
      if (!Array.isArray(content)) return;
      for (const block of content as { type: string; tool_use_id?: string }[]) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue;
        const name = this.#toolNames.get(block.tool_use_id);
        if (!name) continue;
        this.#toolNames.delete(block.tool_use_id);
        this.#emit({ type: 'tool', name, phase: 'end' });
      }
      return;
    }

    if (message.type === 'result') {
      this.#emit({ type: 'done' });
      this.#endTurn();
    }
  }

  #onStreamEvent(event: StreamEvent): void {
    if (event.type === 'content_block_start') {
      const index = event.index ?? 0;
      const block = event.content_block;
      if (block?.type === 'tool_use') {
        this.#blocks.set(index, { kind: 'tool', id: block.id });
        const name = block.name ?? 'tool';
        if (block.id) this.#toolNames.set(block.id, name);
        this.#emit({ type: 'tool', name, phase: 'start' });
      } else {
        this.#blocks.set(index, { kind: 'text' });
      }
      return;
    }

    if (event.type === 'content_block_delta') {
      // thinking_delta and input_json_delta are never spoken.
      if (event.delta?.type === 'text_delta' && event.delta.text) {
        this.#emit({ type: 'text', delta: event.delta.text });
      }
      return;
    }

    if (event.type === 'content_block_stop') {
      const index = event.index ?? 0;
      const block = this.#blocks.get(index);
      this.#blocks.delete(index);
      // A tool block's end is its tool_result, not this. A text block's end,
      // though, has to reach the consumer: measured, a finished sentence with
      // no trailing whitespace sat unspoken for 16 s while the tool it was
      // announcing ran. The whitespace is the block boundary a sentence
      // splitter needs, and it is inaudible if the consumer ignores it.
      if (!block || block.kind === 'text') this.#emit({ type: 'text', delta: '\n' });
    }
  }

  #emit(event: AgentEvent): void {
    const turn = this.#turn;
    if (!turn) return;
    turn.events.push(event);
    turn.wake?.();
    turn.wake = undefined;
  }

  #endTurn(): void {
    const turn = this.#turn;
    this.#turn = undefined;
    this.#blocks.clear();
    if (!turn) return;
    turn.ended = true;
    turn.wake?.();
    turn.wake = undefined;
    turn.markSettled();
  }

  #failTurn(error: unknown): void {
    const turn = this.#turn;
    if (turn) turn.error = error;
    this.#endTurn();
  }

  async *send(text: string): AsyncIterable<AgentEvent> {
    const query = this.#query;
    if (!query) throw new Error('AgentSession.start() must be called before send()');

    const prefixed = this.#pendingNote ? `${this.#pendingNote}\n\n${text}` : text;
    this.#pendingNote = undefined;

    const turn = createTurn();
    this.#turn = turn;
    this.#input.push(prefixed);

    for (;;) {
      const event = turn.events.shift();
      if (event) {
        yield event;
        continue;
      }
      if (turn.error) throw turn.error;
      if (turn.ended) return;
      await new Promise<void>((resolve) => {
        turn.wake = resolve;
      });
    }
  }

  async interrupt(): Promise<void> {
    const turn = this.#turn;
    // NOT abort: aborting tears the session down and takes ~2 s (spec §6).
    await this.#query?.interrupt();
    if (!turn || turn.ended) return;

    // The killed turn still owes a result. Swallow it here, or it lands in the
    // middle of the next turn and ends it early.
    await withDeadline(turn.settled, this.#interruptDrainMs);
    if (this.#turn === turn) this.#endTurn();
  }

  notifyInterruption(spokenSoFar: string, userSaid: string): void {
    // Without this Claude believes its whole answer was received and keeps
    // talking from a context the user never got (spec §6).
    this.#pendingNote =
      `[L'utente ti ha interrotto. Ha sentito solo: "${spokenSoFar}". ` +
      `Non dare per scontato il resto della tua risposta.] Ha detto: ${userSaid}`;
  }

  onPermissionRequest(handler: (req: PermissionRequest) => Promise<boolean>): void {
    this.#handler = handler;
  }

  /** Exposed for tests: the timeout is the part that must not regress. */
  async handlePermission(req: PermissionRequest): Promise<boolean> {
    const handler = this.#handler;
    if (!handler) return false;

    // The SDK's permission callback has NO deadline. Without this, a user who
    // walks away leaves the session waiting forever, silently (spec §8).
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), this.#config.director.approvalTimeoutMs);
    });
    try {
      return await Promise.race([handler(req), timeout]);
    } catch {
      // A handler that blew up is not a yes. The Director speaks the denial.
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Ends the session. Closing the input stream is what lets the CLI exit cleanly. */
  async close(): Promise<void> {
    const query = this.#query;
    this.#query = undefined;
    this.#input.end();
    const returned = query?.return(undefined).then(
      () => undefined,
      () => undefined,
    );
    await withDeadline(Promise.all([returned, this.#pumpDone]), this.#closeTimeoutMs);
  }
}
