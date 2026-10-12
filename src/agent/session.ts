import { homedir } from 'node:os';
import {
  startup,
  type HookJSONOutput,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, AgentSession, PermissionRequest } from '../types.ts';
import type { Config } from '../config.ts';

/** Reused wherever a tool call is refused for lack of the user's spoken yes. */
const NO_SPOKEN_CONFIRMATION = "L'utente non ha confermato a voce.";

const SPOKEN_STYLE = `
Stai parlando a voce, non scrivendo. Frasi brevi, tono naturale, niente elenchi puntati.
Sii sintetico: vai dritto al punto nella prima frase, senza premesse o giri di
parole. Non ripetere la stessa cosa con parole diverse e non allungare le
frasi con riempitivi ("dunque", "allora", "quindi", puntini di sospensione
ripetuti). Se serve dettaglio, aggiungilo dopo, non prima, del punto centrale.
Non leggere mai codice ad alta voce: scrivilo e dì "te l'ho scritta".
Accorcia i percorsi dei file. Gli strumenti che hai sono veri: usali davvero.
Se la domanda richiede una ricerca (notizie, orari, risultati sportivi, prezzi,
voli, qualunque cosa cambi nel tempo), cerca sul serio: usa gli strumenti,
prova query diverse se la prima non basta, e non fermarti al primo tentativo
vuoto. "Non lo so" o "non ho trovato nulla" va detto solo dopo aver
effettivamente cercato, mai come scorciatoia. Se la ricerca fallisce per un
problema tecnico, dillo chiaramente invece di restare in silenzio.
Rispondi sempre nella stessa lingua in cui è scritto il messaggio dell'utente:
se scrive in inglese, rispondi in inglese; se scrive in italiano, rispondi in
italiano — anche se prima nella conversazione avevi parlato in un'altra lingua.
Resta dentro il perimetro di quello che ti è stato chiesto: fai esattamente
quello, non azioni aggiuntive non richieste, non passi successivi "di tua
iniziativa". Se un compito ha più step ovvi e collegati, chiedi conferma prima
di procedere oltre il primo invece di eseguirli tutti in autonomia.
`.trim();

/**
 * How long interrupt() waits for the CLI to close off the turn it just killed.
 * Bounded because the microphone is already open when this runs: a barge-in
 * that blocks is worse than a turn whose tail is dropped.
 */
const INTERRUPT_DRAIN_MS = 2000;
const CLOSE_TIMEOUT_MS = 2000;

/**
 * How long the CLI's tail output for an abandoned turn is still expected,
 * once we've given up waiting on it (interrupt() or its drain timed out).
 *
 * The CLI processes turns over a single ordered stream, one at a time: it
 * cannot start streaming a NEW turn's own output before it reports the old
 * one done, so anything that arrives while this window is armed — the
 * result and any stream events alike — still belongs to the turn we gave up
 * on, never to whatever #turn has been reassigned to since. #emit() drops
 * everything while it is armed; #dispatch's result branch swallows the one
 * `result` message directly (see #takeStaleResult). Bounded the other way
 * too: a result that never arrives at all would otherwise leave the
 * quarantine armed for ever, both eating a legitimate future result and
 * silently dropping a legitimate future turn's speech.
 */
const STALE_RESULT_WINDOW_MS = 10_000;

/**
 * How long #clearConversation waits for the CLI to confirm a "/clear" with
 * its conversation_reset message, before giving up. "/clear" is a LOCAL
 * command (sdk.d.ts's TerminalReason doc comment: "Unset when the loop was
 * bypassed (local slash command)") — it never reaches the model, so a slow
 * reply here would mean something is already badly wrong with the
 * subprocess, not ordinary turn latency. Short on purpose, and best-effort:
 * see #clearConversation.
 */
const CLEAR_CONFIRM_MS = 2000;

/**
 * The warm-up turn's throwaway message (see #warmUp). Used to be a bare '.',
 * which is ambiguous — combined with the system prompt's "search seriously,
 * don't give up after one empty attempt" instruction, it could invite the
 * model to reach for a real tool call during warm-up, before any permission
 * handler is attached. For WebSearch/WebFetch specifically that bypasses
 * canUseTool entirely (they're in allowedTools, spec §8/buildOptions), and a
 * real in-flight HTTP call cannot be reliably stopped by interrupt(). An
 * explicit, unambiguous instruction not to use any tool closes that off —
 * though see #enterPlanMode/#exitPlanMode and the PreToolUse hook below for
 * why this alone isn't considered sufficient defense-in-depth.
 */
export const WARM_UP_MESSAGE =
  "Rispondi soltanto con 'ok', in una parola, senza usare alcuno strumento " +
  '(niente ricerche, niente file, nessuna azione): è solo un test di ' +
  'connessione, non una vera domanda.';

export function buildOptions(config: Config): Options {
  return {
    model: 'sonnet',
    includePartialMessages: true,
    // Without this the bundled CLI computes its OAuth Keychain service name
    // from an unset config dir ("Claude Code-credentials", no suffix) instead
    // of the one the interactive `claude` CLI actually uses ("...-<hash of
    // ~/.claude>"). Two entries for one account meant this long-running
    // process refreshed a copy nobody else maintained, and a single failed
    // refresh (invalid_grant) triggers the CLI's local-logout path, which
    // deletes that entry outright — silently breaking every future turn until
    // someone notices and copies the other entry's token back over by hand.
    // Matching the interactive CLI's env merges both onto the one entry it
    // already keeps valid.
    env: { ...process.env, CLAUDE_CONFIG_DIR: `${homedir()}/.claude` },
    // All three are required. strictMcpConfig ignores project/user/plugin MCP
    // config; mcpServers leaves nothing to connect; settingSources must be
    // explicit because its default loads everything (spec §12). Measured: with
    // the user's MCP servers connected a turn costs 5-7 s more.
    strictMcpConfig: true,
    mcpServers: {},
    settingSources: ['user'],
    // `tools` is what makes a tool available at all; `allowedTools` only
    // controls which of the available ones skip the confirmation prompt. Without
    // this, WebSearch/WebFetch were never offered to the model regardless of
    // allowedTools listing them.
    tools: { type: 'preset', preset: 'claude_code' },
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
  /** True once interrupt() has been called for this turn. */
  interrupted: boolean;
}

function createTurn(): Turn {
  let markSettled = (): void => {};
  const settled = new Promise<void>((resolve) => {
    markSettled = resolve;
  });
  return {
    events: [],
    wake: undefined,
    ended: false,
    error: undefined,
    settled,
    markSettled,
    interrupted: false,
  };
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
  readonly #staleResultWindowMs: number;

  #query: Query | undefined;
  #input = makeInputStream();
  #pumpDone: Promise<void> = Promise.resolve();
  #handler: ((req: PermissionRequest) => Promise<boolean>) | undefined;
  #pendingNote: string | undefined;
  readonly #debugFn: ((message: string) => void) | undefined;

  /** The turn currently being consumed, if any. Messages outside one are dropped. */
  #turn: Turn | undefined;
  /** Content-block index -> what kind of block it is, for this turn. */
  #blocks = new Map<number, { kind: 'text' | 'tool'; id?: string }>();
  /** tool_use id -> tool name, so a tool_result can close the bracket. */
  #toolNames = new Map<string, string>();
  /**
   * How many abandoned turns' tails (their result AND any stream events) are
   * still expected. See STALE_RESULT_WINDOW_MS.
   *
   * A counter, not a boolean/single-timer, because two ghosts can be owed at
   * once: warm-up's give-up path can arm one, and a later turn's interrupt()
   * give-up can arm a second before the first ghost's belated result has
   * landed. A single slot here used to mean the second arm() clobbered the
   * first's timer, and consuming EITHER ghost's result cleared the whole
   * quarantine — so the still-owed other ghost's later result (or stream
   * events) would then leak into whatever new turn had since started. Each
   * #armStaleResult() call increments this by one; each consumption (a
   * belated result via #takeStaleResult, or that ghost's own window simply
   * elapsing with nothing arriving) decrements it by one — never resets it to
   * zero, since a sibling ghost may still be outstanding.
   */
  #staleResults = 0;
  /**
   * One timer handle per outstanding ghost (see #staleResults), in arm order.
   * Exists so an early consumption (#takeStaleResult, a belated result
   * landing before its own window elapses) can cancel THAT ghost's timer
   * outright, instead of merely decrementing the counter and leaving the
   * timer alive to fire later anyway. An unref'd setTimeout that outlives its
   * own consumption used to fire a second, phantom #releaseStaleResult() for
   * a ghost that was already gone — if a second, genuinely-still-outstanding
   * ghost had since been armed, that phantom decrement zeroed the counter
   * early, lifted tool suppression, and let the still-outstanding ghost's own
   * later result/stream events leak into whatever real turn was running at
   * the time (confirmed by reproduction, spec round 6). Each entry's own
   * callback (see #armStaleResult) removes itself from this array before
   * calling #releaseStaleResult, so a handle that #takeStaleResult already
   * spliced out and cleared can never do that a second time.
   */
  #staleResultTimers: NodeJS.Timeout[] = [];
  /** Resolves the in-flight #clearConversation() call, if one is pending. */
  #pendingClearResolve: (() => void) | undefined;
  /**
   * True while a give-up (warm-up or interrupt()) has put the session into
   * 'plan' mode and no tool call should execute: gates both the
   * setPermissionMode('plan') call itself and the PreToolUse hook that backs
   * it up (see #enterPlanMode/#exitPlanMode/#denyToolsWhileSuppressed). One
   * name for both, because they are one mechanism: plan mode is the SDK's own
   * signal that no tool should run, and the hook is what actually enforces it
   * for the two tools (WebSearch/WebFetch) that skip canUseTool entirely.
   */
  #suppressTools = false;

  constructor(
    config: Config,
    opts: {
      startupFn?: typeof startup;
      interruptDrainMs?: number;
      closeTimeoutMs?: number;
      staleResultWindowMs?: number;
      debug?: (message: string) => void;
    } = {},
  ) {
    this.#config = config;
    this.#startupFn = opts.startupFn ?? startup;
    this.#interruptDrainMs = opts.interruptDrainMs ?? INTERRUPT_DRAIN_MS;
    this.#closeTimeoutMs = opts.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
    this.#staleResultWindowMs = opts.staleResultWindowMs ?? STALE_RESULT_WINDOW_MS;
    this.#debugFn = opts.debug;
  }

  /** No-op unless a `debug` dep was injected — never a bare `console.log`/`console.error` here. */
  #debug(message: string): void {
    this.#debugFn?.(message);
  }

  /**
   * Puts the live query into 'plan' mode, the SDK's own no-tool-execution
   * mode, so a give-up (warm-up or interrupt()) cannot leave a real tool call
   * running unsupervised (see WARM_UP_MESSAGE, #suppressTools). Bounded by
   * the same budget as the give-up path's own interrupt() call: a hung
   * mode-switch must not itself hang anything, and there is nothing useful to
   * do if it fails beyond leaving the hook (#denyToolsWhileSuppressed) as the
   * enforcement of last resort.
   */
  async #enterPlanMode(): Promise<void> {
    this.#suppressTools = true;
    await withDeadline(
      Promise.resolve(this.#query?.setPermissionMode('plan')).catch(() => undefined),
      this.#config.director.interruptTimeoutMs,
    );
  }

  /** The inverse of #enterPlanMode: see there for why both are bounded and best-effort. */
  async #exitPlanMode(): Promise<void> {
    this.#suppressTools = false;
    await withDeadline(
      Promise.resolve(this.#query?.setPermissionMode('default')).catch(() => undefined),
      this.#config.director.interruptTimeoutMs,
    );
  }

  /**
   * The PreToolUse hook backing #suppressTools. The SDK's own docs warn that
   * bare allowedTools entries (WebSearch/WebFetch/ToolSearch here, spec
   * §8/buildOptions) auto-approve before canUseTool is even consulted; a
   * PreToolUse hook is the one gate the SDK documents as running before every
   * tool call regardless. When nothing is suppressed this is a no-op ({}):
   * every field on the sync hook output is optional, and an empty object
   * means "continue, no opinion".
   */
  async #denyToolsWhileSuppressed(): Promise<HookJSONOutput> {
    if (!this.#suppressTools) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: NO_SPOKEN_CONFIRMATION,
      },
    };
  }

  /**
   * Pre-warms the subprocess (~900 ms) AND the first real model round trip, so
   * turn 1 does not pay for either.
   *
   * The subprocess spawn + control-protocol handshake used to be the only
   * thing paid for here. The actual first API call — cold TLS, the first
   * prompt-cache write for the (large) system prompt, credential/token use —
   * was still deferred to the user's first spoken utterance. That first real
   * round trip can occasionally run far longer than later turns, and when it
   * did, the Director's 45 s turn watchdog could fire before it finished:
   * the user's real first question got aborted in silence, with zero events
   * ever emitted. Sending a throwaway message through the same turn
   * machinery here moves that cost into boot, where "scaldo la sessione…"
   * already sets the expectation of a wait.
   */
  async start(): Promise<void> {
    const options: Options = {
      ...buildOptions(this.#config),
      canUseTool: async (toolName, input, opts) => {
        // Dispatching a subagent ('Agent' is the SDK's actual tool name for
        // this — sdk.d.ts's own doc comment on Options.agents: "custom
        // subagents that can be invoked via the Agent tool"; AgentInput's
        // fields are description/prompt/subagent_type, never 'Task') is, on
        // its own, inert: it starts a background conversation, nothing more.
        // Gating it behind a spoken "sì" added a second approval round trip
        // (now up to approvalTimeoutMs on top of the dispatch itself) to
        // things as inert as a web search, because 'Agent' isn't in
        // config.readOnlyTools.
        //
        // Keying auto-approval off `input.subagent_type` was considered and
        // rejected: every custom agent under ~/.claude/agents (job-hunter
        // included, loaded here because settingSources includes 'user') omits
        // AgentDefinition.tools, which per the SDK means it inherits every
        // tool the parent session has — there is no declared, trustworthy
        // signal that a given subagent_type is read-only, only prose in its
        // description. Matching on that prose would be a fragile heuristic
        // standing in for a real safety gate.
        //
        // What actually makes skipping approval HERE safe: this session's
        // query pipeline is one thing — main loop, subagent, and sidechain
        // tool calls all flow through this same canUseTool (sdk.d.ts groups
        // them together) — and AgentInput.mode's doc comment confirms
        // subagents inherit the parent's permission mode by default. So a
        // dispatched subagent's own Write/Edit/Bash/etc. calls still hit this
        // exact gate individually; approving the dispatch does not approve
        // anything the subagent goes on to do. The one documented escape
        // hatch is AgentDefinition.permissionMode, which a subagent's own
        // frontmatter could set to bypass this callback entirely — checked
        // every file under ~/.claude/agents and none set it today, but a
        // future agent definition that does would need this comment revisited.
        if (toolName === 'Agent') return { behavior: 'allow' as const, updatedInput: input };

        // The bridge already renders a sentence that reads back sensibly; a
        // reconstruction from tool name plus raw input does not (spec §8).
        const title = (opts as { title?: string }).title;
        const allowed = await this.handlePermission({
          tool: toolName,
          summary: title ?? `Claude vuole usare ${toolName}`,
        });
        return allowed
          ? { behavior: 'allow' as const, updatedInput: input }
          : { behavior: 'deny' as const, message: NO_SPOKEN_CONFIRMATION };
      },
      hooks: { PreToolUse: [{ hooks: [() => this.#denyToolsWhileSuppressed()] }] },
      // The one place visibility into the underlying `claude` CLI subprocess's
      // own stderr exists at all (sdk.d.ts: Options.stderr). Without this, a
      // subprocess that errors, crashes, or fails to authenticate produces
      // zero observable signal anywhere in this codebase.
      stderr: (data: string) => this.#debug(`agent: cli stderr: ${data}`),
    };

    this.#debug('agent: starting claude CLI subprocess…');
    const warm = await this.#startupFn({ options });
    this.#debug('agent: subprocess started, awaiting warm-up');
    const query = warm.query(this.#input.stream);
    this.#query = query;
    this.#pumpDone = this.#pump(query);
    await this.#warmUp();
  }

  /**
   * Pushes one throwaway message (WARM_UP_MESSAGE) through the real turn machinery
   * (createTurn / #input.push / turn.settled — the exact path send() uses)
   * and waits for it to settle, so the first genuine API round trip happens
   * during start() instead of on the caller's first send(). Its events are
   * never read by anyone: the array they land in goes out of scope with the
   * turn.
   *
   * Bounded by config.director.turnTimeoutMs rather than a new constant of
   * its own: it is the same question the Director's watchdog already
   * answers — "how long is a legitimately slow round trip allowed to run
   * before something has gone genuinely wrong" — so duplicating that budget
   * under a different name would only invite the two to drift apart. Best
   * effort only: a warm-up that times out must not throw and abort startup,
   * it must just stop waiting.
   *
   * The give-up path below mirrors interrupt() exactly, and for the same
   * reason: on timeout the CLI is still actively working on the abandoned
   * warm-up turn, and merely arming the stale-result quarantine does not stop
   * it. Quarantine only guards the one `result` message a turn owes — it
   * does nothing on its own for stream events, which #emit() would
   * otherwise append to whatever #turn currently is. Left unchecked, any
   * content_block_start/text_delta/tool events the CLI produces in belated
   * reply to it would land directly in the caller's first real turn and get
   * spoken; #emit() now also drops events while the quarantine is armed (see
   * #staleResults), which is what actually closes that gap. Calling
   * `this.#query.interrupt()` first actually stops the CLI from continuing
   * that turn, and draining for `this.#interruptDrainMs` gives its already
   * in-flight output (including the final result) time to land while #turn
   * is still the doomed turn, instead of the next one — so only the rare
   * straggler that outlives the drain window still needs the quarantine.
   *
   * The `interrupt()` call itself is bounded by
   * `config.director.interruptTimeoutMs`, the same budget and the same
   * hazard the Director's own bounded-interrupt wrapper guards against (see
   * director.ts #interrupt): the SDK gives no guarantee interrupt() returns
   * promptly while a background subagent Task is still running (spec:
   * 2026-09-26, a barge-in that froze the whole app because interrupt()
   * never came back). Everywhere else that hazard sits behind the
   * Director's own bound; here it would sit directly on `start()`, which
   * `src/cli.ts` awaits with no race of its own — a hang here would freeze
   * boot forever, not just one turn. A timed-out interrupt() falls straight
   * into the same give-up path as a timed-out drain, on purpose: whichever
   * one didn't return in time, the CLI may still be mid-flight, and the
   * response is identical either way.
   *
   * Every exit path below ends with #clearConversation(), on purpose: the
   * CLI's `query()` handle can only be sent a prompt once (sdk.d.ts's
   * WarmQuery.query() doc comment — "Can only be called once per
   * WarmQuery"), so there is no way to warm the subprocess in one
   * conversation and then hand the caller a second, genuinely separate one
   * — the warm-up message and the user's real first turn are necessarily
   * the same long-lived SDK conversation. Left alone, that means every
   * later turn carries the warm-up's own throwaway exchange ("Rispondi
   * soltanto con 'ok'…" / Claude's reply) as real prior context, forever —
   * paid for in tokens on every turn, and able to bias the first genuine
   * answer. #clearConversation() erases it immediately afterward via the
   * CLI's own "/clear" local command, which resets the conversation without
   * spawning a new subprocess or paying for a second round trip.
   */
  async #warmUp(): Promise<void> {
    this.#debug('agent: warm-up starting');
    const turn = createTurn();
    this.#turn = turn;
    // Plan mode first, THEN the message: a model that reached for a tool on
    // its very first content block, before this resolved, would still slip
    // through (see WARM_UP_MESSAGE and #enterPlanMode).
    await this.#enterPlanMode();
    this.#debug('agent: warm-up pushing throwaway message');
    this.#input.push(WARM_UP_MESSAGE);
    await withDeadline(turn.settled, this.#config.director.turnTimeoutMs);
    if (this.#turn !== turn) {
      // settled already; #endTurn cleared it
      this.#debug('agent: warm-up settled normally');
      await this.#exitPlanMode();
      await this.#clearConversation();
      return;
    }

    // Mark the turn before the interrupt fires: the result the CLI emits for
    // it is an error (error_during_execution), and must read as the expected
    // end of a turn we gave up on, not as a genuine failure.
    turn.interrupted = true;
    this.#debug('agent: warm-up timed out, interrupting');
    // NOT abort: aborting tears the session down and takes ~2 s (spec §6).
    await withDeadline(
      Promise.resolve(this.#query?.interrupt()).catch(() => undefined),
      this.#config.director.interruptTimeoutMs,
    );
    if (turn.ended) {
      this.#debug('agent: warm-up interrupt succeeded');
      await this.#exitPlanMode();
      await this.#clearConversation();
      return;
    }

    // The abandoned turn still owes a result — whether interrupt() returned
    // in time or not. Swallow it here, or it lands in the middle of the next
    // turn and ends it early.
    await withDeadline(turn.settled, this.#interruptDrainMs);
    if (this.#turn !== turn) {
      this.#debug('agent: warm-up drained after interrupt');
      await this.#exitPlanMode();
      await this.#clearConversation();
      return;
    }

    // Still ours means neither interrupt() nor the result it should have
    // provoked came back within budget. Ending the turn locally frees
    // start() to resolve, but the CLI may still be mid-flight: arm the
    // quarantine so both the belated result and any belated stream events
    // are swallowed instead of leaking into the next turn. Plan mode/tool
    // suppression stays armed too — the CLI could still act on the abandoned
    // turn — and is only lifted early if #takeStaleResult sees the belated
    // result land; otherwise this same timer is what eventually restores
    // default mode once the quarantine window elapses with nothing arriving.
    this.#debug('agent: warm-up gave up, neither interrupt() nor its result returned in time');
    this.#armStaleResult();
    this.#endTurn();
    // Queued behind whatever the abandoned turn still owes: the CLI's single
    // ordered stream (see STALE_RESULT_WINDOW_MS) means this cannot jump
    // ahead of it, so the quarantine above still does its job regardless of
    // when the clear itself gets confirmed.
    await this.#clearConversation();
  }

  /**
   * Erases the warm-up's own throwaway exchange from the conversation every
   * real turn shares, via the CLI's built-in "/clear" local command (see
   * #warmUp's doc comment for why this, rather than a second SDK session, is
   * the fix). "/clear" never reaches the model — sdk.d.ts documents it as a
   * LOCAL command the CLI's own loop handles without a turn — and the CLI
   * confirms it with a dedicated `conversation_reset` message instead of the
   * ordinary result/turn machinery #turn tracks, so this is deliberately NOT
   * wired through createTurn()/#emit(): no model turn ever runs for it, and
   * nothing here should be mistaken for one by the stale-result quarantine.
   * Best-effort and bounded (CLEAR_CONFIRM_MS): if the CLI never confirms,
   * there is nothing more useful to do than stop waiting — the "/clear" sent
   * either still lands later or the subprocess is already in worse trouble
   * than this method could fix.
   */
  async #clearConversation(): Promise<void> {
    this.#debug('agent: clearing warm-up exchange from conversation context');
    await withDeadline(
      new Promise<void>((resolve) => {
        this.#pendingClearResolve = resolve;
        this.#input.push('/clear');
      }),
      CLEAR_CONFIRM_MS,
    );
    this.#pendingClearResolve = undefined;
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
        // content_block_delta fires once per streamed token. content_block_start
        // and _stop fire once per block (text run, tool call) and do carry
        // structural detail (block type, tool name/id), but at one line per
        // block start/stop this is still too frequent to log by default — the
        // tool name is available elsewhere in AXA_DEBUG output via the
        // 'tool: start <name>' emit (`#onStreamEvent`), so nothing is actually
        // lost by staying quiet here. Every other stream_event subtype
        // (message_start, tool_use, etc.) is still logged. "system"-typed
        // messages collapse dozens of distinct subtypes (hooks, tool progress,
        // rate limits, ...) under one bare `type`, so the subtype is logged
        // too — otherwise every one of them looks identical and says nothing.
        const eventType =
          next.value.type === 'stream_event' ? (next.value.event as StreamEvent).type : undefined;
        const isNoisy = eventType === 'content_block_delta' || eventType === 'content_block_start' ||
          eventType === 'content_block_stop';
        if (!isNoisy) {
          // For a stream_event this would only ever read "type=stream_event"
          // (no `subtype` exists on one) with the actually informative part —
          // the event's own type — logged a moment later by `#dispatch`
          // itself. Log that directly here instead of the redundant wrapper
          // type, and leave non-stream_event messages (where `type=` IS the
          // informative part) exactly as they were.
          if (next.value.type === 'stream_event') {
            this.#debug(`agent: received stream_event type=${eventType}`);
          } else {
            const subtype = (next.value as { subtype?: string }).subtype;
            this.#debug(
              `agent: received message type=${next.value.type}` + (subtype ? ` subtype=${subtype}` : ''),
            );
          }
        }
        this.#dispatch(next.value);
      }
      this.#failTurn(new Error('The Claude session ended.'));
    } catch (error) {
      // #failTurn only records the error onto a turn if one is active; with
      // none active (between turns, or the subprocess dying right as close()
      // clears #query) it would otherwise vanish with no trace at all.
      this.#debug(
        `agent: pump loop threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      this.#failTurn(error);
    }
  }

  /**
   * The one useful debug line for a stream_event is now logged by `#pump`
   * itself, gated on its own `isNoisy` check (true for content_block_delta,
   * _start and _stop — not merely "is this a delta", the misleading name an
   * earlier version of this parameter had here). Nothing left for this method
   * to log for stream_event, so the parameter that used to carry that flag
   * down from `#pump` is gone rather than renamed-but-unused.
   */
  #dispatch(message: SDKMessage): void {
    if (message.type === 'conversation_reset') {
      // The CLI's confirmation that a pushed "/clear" took effect (see
      // #clearConversation). Never routed through #turn/#emit: no model turn
      // ran for it, so there is no turn here to end or events to append to.
      this.#debug('agent: conversation reset (warm-up exchange cleared)');
      this.#pendingClearResolve?.();
      this.#pendingClearResolve = undefined;
      return;
    }

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
      this.#debug(`agent: dispatch result subtype=${message.subtype} is_error=${message.is_error}`);
      if (this.#takeStaleResult()) return;
      const turn = this.#turn;
      if (message.subtype === 'success' && !message.is_error) {
        this.#emit({ type: 'done' });
        this.#endTurn();
        return;
      }
      if (turn?.interrupted) {
        // The result a turn we cut still owed: expected, not a failure. The CLI
        // reports an interrupted turn as error_during_execution.
        this.#emit({ type: 'done' });
        this.#endTurn();
        return;
      }
      const detail = message.subtype === 'success' ? message.result : message.subtype;
      this.#failTurn(new Error(`Claude ended the turn with an error: ${detail}`));
    }
  }

  /**
   * Arms the quarantine for one more ghost turn (see #staleResults), on the
   * give-up path of either #warmUp or interrupt(). Each ghost gets its own
   * timer rather than sharing/clobbering one, so two overlapping give-ups are
   * each independently swallowed: one ghost's window elapsing must only ever
   * release ITS OWN slot, never a sibling ghost's.
   */
  #armStaleResult(): void {
    this.#staleResults += 1;
    const timer = setTimeout(() => {
      // If this handle is no longer in the array, #takeStaleResult already
      // consumed this exact ghost (and cleared this same timer) earlier —
      // firing #releaseStaleResult() again here would be the phantom second
      // decrement this array exists to prevent (see its doc comment).
      const index = this.#staleResultTimers.indexOf(timer);
      if (index === -1) return;
      this.#staleResultTimers.splice(index, 1);
      this.#releaseStaleResult();
    }, this.#staleResultWindowMs);
    timer.unref();
    this.#staleResultTimers.push(timer);
  }

  /**
   * Releases exactly one owed ghost, whether because its belated result
   * landed (#takeStaleResult) or because its own quarantine window simply
   * elapsed with nothing arriving (the timer #armStaleResult set). Only
   * restores default mode once NO ghost is left outstanding: a sibling ghost
   * from an overlapping give-up may still be owed.
   */
  #releaseStaleResult(): void {
    this.#staleResults = Math.max(0, this.#staleResults - 1);
    if (this.#staleResults === 0 && this.#suppressTools) void this.#exitPlanMode();
  }

  /** True if this result belongs to a turn that was already given up on. */
  #takeStaleResult(): boolean {
    if (this.#staleResults <= 0) return false;
    // Cancel THIS ghost's own timer before decrementing: left alive, it would
    // still fire later and decrement a second time for a single ghost (see
    // #staleResultTimers' doc comment). Which handle is irrelevant — every
    // outstanding ghost's window guards the identical quarantine — so the
    // oldest is taken FIFO, same order #armStaleResult pushed them in.
    const timer = this.#staleResultTimers.shift();
    if (timer) clearTimeout(timer);
    this.#releaseStaleResult();
    return true;
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
    // While the quarantine from a give-up (#warmUp or interrupt()) is armed,
    // the CLI is still flushing the turn(s) we abandoned, not whatever #turn
    // has been reassigned to since — the single ordered stream cannot have
    // moved on yet (see STALE_RESULT_WINDOW_MS). Anything that arrives here
    // still belongs to a ghost, not to the caller's real turn.
    if (this.#staleResults > 0) return;
    turn.events.push(event);
    turn.wake?.();
    turn.wake = undefined;
  }

  #endTurn(): void {
    const turn = this.#turn;
    this.#turn = undefined;
    this.#blocks.clear();
    // Not cleared, a tool_result left over from this turn brackets a tool the
    // next turn never started.
    this.#toolNames.clear();
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
    this.#debug('agent: send() called, pushing turn');
    // A previous turn's give-up quarantine may still be armed (see #warmUp /
    // interrupt() / STALE_RESULT_WINDOW_MS). A brand-new real turn starting
    // must not be silently held in "no tool execution" mode waiting for that
    // window to elapse on its own. Awaited, not fired-and-forgotten: the new
    // turn's message is pushed right after this, and a real tool call in that
    // turn must not race the mode switch back to 'default'.
    if (this.#suppressTools) await this.#exitPlanMode();
    // #staleResults itself is deliberately left armed here, unlike
    // #suppressTools above: the single-ordered-stream guarantee (see
    // STALE_RESULT_WINDOW_MS) means each abandoned turn's belated tail is
    // still guaranteed to arrive, and to arrive BEFORE anything the CLI
    // emits for this new turn -- clearing it early would let that belated
    // tail be misattributed to the turn started below instead of being
    // caught by #takeStaleResult()/#emit() as the ghost output it is (see
    // the "warm-up give-up interrupts the CLI" test, which asserts exactly
    // this ordering).
    const query = this.#query;
    if (!query) throw new Error('AgentSession.start() must be called before send()');

    const prefixed = this.#pendingNote ? `${this.#pendingNote}\n\n${text}` : text;
    this.#pendingNote = undefined;

    const turn = createTurn();
    this.#turn = turn;
    this.#input.push(prefixed);

    let firstEvent = true;
    for (;;) {
      const event = turn.events.shift();
      if (event) {
        if (firstEvent) {
          firstEvent = false;
          this.#debug(`agent: turn yielding first event type=${event.type}`);
        }
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
    // Mark the turn before the interrupt fires: the result the CLI emits for it
    // is an error (error_during_execution), and must read as the expected end of
    // a turn we cut, not as a genuine failure to surface to the caller.
    if (turn && !turn.ended) turn.interrupted = true;
    // NOT abort: aborting tears the session down and takes ~2 s (spec §6). Fired
    // concurrently with #enterPlanMode, not sequenced after it: the microphone
    // is already open, and doubling the barge-in latency to buy a mode switch
    // that is itself only defense-in-depth would be the wrong trade.
    //
    // The raw `query.interrupt()` call is bounded by the same
    // `interruptTimeoutMs` #enterPlanMode already uses internally, NOT left
    // to run unbounded inside this Promise.all: the Director's own
    // `#interrupt()` wrapper (director.ts) races a timer against this whole
    // method, but that wrapper giving up does nothing to the call still
    // pending in here — a hung SDK interrupt() would keep this `await`
    // suspended well past the Director's own deadline, with #turn still
    // pointing at the turn this method was supposed to be retiring. The
    // Director would move on believing the stale-result quarantine is
    // armed (see #armStaleResult below) when in fact this method never got
    // that far, so the abandoned turn's belated events/result would reach
    // whatever new turn `send()` had since started — the exact leak
    // #armStaleResult/#takeStaleResult exist to prevent. Without its own
    // bound here, nothing upstream can close that gap.
    await Promise.all([
      this.#enterPlanMode(),
      withDeadline(
        Promise.resolve(this.#query?.interrupt()).catch(() => undefined),
        this.#config.director.interruptTimeoutMs,
      ),
    ]);
    if (!turn || turn.ended) {
      await this.#exitPlanMode();
      return;
    }

    // The killed turn still owes a result. Swallow it here, or it lands in the
    // middle of the next turn and ends it early.
    await withDeadline(turn.settled, this.#interruptDrainMs);
    if (this.#turn !== turn) {
      await this.#exitPlanMode();
      return;
    }

    // Still ours means the result never came within the drain window. Ending the
    // turn locally frees the Director, but the result is still in the pipe and
    // has to be caught when it lands. Plan mode stays armed until then; see
    // #warmUp's identical quarantine-timer comment for why the timer itself is
    // the eventual restore path if no result ever arrives.
    this.#armStaleResult();
    this.#endTurn();
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
    } catch (error) {
      // A handler that blew up is not a yes. The Director speaks the denial.
      this.#debug(
        `agent: permission handler threw: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Ends the session. Closing the input stream is what lets the CLI exit cleanly. */
  async close(): Promise<void> {
    const query = this.#query;
    this.#query = undefined;
    this.#takeStaleResult();
    // Any ghost still outstanding after the one #takeStaleResult() above just
    // consumed has no result coming: the session is going away regardless.
    // Left alive, an unref'd timer here would not keep the process open, but
    // would still be a dangling handle firing (harmlessly, but pointlessly)
    // into a torn-down session — clear them all rather than let them leak
    // past shutdown.
    for (const timer of this.#staleResultTimers.splice(0)) clearTimeout(timer);
    this.#input.end();
    const returned = query?.return(undefined).then(
      () => undefined,
      () => undefined,
    );
    await withDeadline(Promise.all([returned, this.#pumpDone]), this.#closeTimeoutMs);
  }
}
