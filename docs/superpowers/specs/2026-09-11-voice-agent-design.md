# axa-voice — Design

**Date:** 2026-09-11
**Status:** Approved. Revised 2026-09-11 with measurements from the M0 prototype
(`proto/talk.mjs`) — §4 latency, §8 tool permissions, §12 stack.

## In breve (IT)

Un'app che ti fa **parlare con Claude a voce**: parli, lui risponde in circa un secondo
e mezzo, e puoi interromperlo a metà frase come faresti con una persona. Gira a casse
aperte (niente cuffie obbligatorie) perché cancella l'eco delle proprie casse dal
microfono. Non legge mai il codice ad alta voce: quello resta a schermo, a voce arriva
solo il senso. **Legge sempre** (file, web) senza chiedere; per **scrivere o eseguire**
ti chiede a voce e aspetta un "sì" — e se non capisce bene, dice di no.
Più avanti lo stesso flusso audio pilota un avatar 3D e poi un proiettore olografico.

---

## 1. Goal

Let the user hold a spoken conversation with Claude while working at the computer:
speak instead of typing, hear the answer, interrupt mid-sentence and be understood.

The target is not "text-to-speech on top of Claude". The target is the quality gap
between Siri and a person, which is produced by three things and not by voice timbre:

1. **Time to first sound** under ~1.5 s (Siri: ~2 s). See §4 — the original ~1 s target
   was an estimate; 1.5 s is what the hardware and the model actually deliver.
2. **Barge-in** — interrupting works, and the agent knows where it was cut off.
3. **Spoken-appropriate content** — it says the meaning, not the code.

### Non-goals (this spec)

- Wake word / always-on ambient listening.
- 3D avatar rendering and holographic output. Designed for, not built here.
- Multi-user, remote access, or mobile.
- Windows/Linux support. macOS only for M1.

## 2. Why this is not a Claude Code plugin

Researched against the Claude Code docs (2026-09-11). Two findings are load-bearing:

- **No mechanism exists to inject a user turn into a running interactive session.**
  `UserPromptSubmit` fires before Claude processes a prompt and can block it (exit 2)
  but cannot rewrite it. MCP servers respond to tool calls, they cannot initiate turns.
  Monitors push one-way notifications only. `claude -p` / `--resume` drive
  non-interactive sessions, not a live terminal.
  (https://code.claude.com/docs/en/hooks.md, https://code.claude.com/docs/en/mcp.md)
- **No hook receives streaming tokens.** `Stop` / `SubagentStop` deliver
  `last_assistant_message` only after generation finishes — too late for a streaming
  TTS, which is what buys the sub-second latency.
  (https://code.claude.com/docs/en/hooks.md)

A plugin can therefore speak Claude's output but can never hear the user, and can only
speak after the full answer is done. Both halves of the goal are blocked.

**Consequence:** build a standalone app that owns the turn loop, driving Claude through
the Agent SDK with token streaming. It reads `~/.claude/` so the user's existing skills,
agents and MCP servers work unchanged. A thin plugin wrapper exposing `/voice` to launch
the app comes in Milestone 2 — packaging, not architecture.

## 3. Architecture

Eight components. Seven are deliberately stupid; one (the Director) holds all the logic.

```
   mic ──▶ AudioInput ──▶ TurnDetector ──▶ Transcriber ──┐
            (AEC)              │                          │
              ▲                ▼                          ▼
              │          "user started"              "user said X"
              │                │                          │
              │                ▼                          ▼
              │        ┌───────────────────────────────────────┐
              │        │             DIRECTOR                  │
              │        │  LISTENING→HEARING→THINKING→SPEAKING  │
              │        │        └────── AWAITING_APPROVAL ─────┤
              │        └───────────────────────────────────────┘
              │                │                          │
              │                ▼                          ▼
              │         AgentSession ──▶ SpeechFilter ──▶ Voice
              │         (Claude SDK)     (what to say)    (TTS)
              │                                            │
              └──── playback reference ── AudioOutput ◀────┘
                                              │
                                              ▼
                                        OutputSink[]
                                     (avatar, later)
```

### Audio formats

Fixed across all components, no negotiation:

- **Capture:** 16 kHz, mono, PCM16, 20 ms frames (320 samples).
- **Playback:** 24 kHz, mono, PCM16. `Voice` implementations resample to this.
- `AudioFrame = Int16Array`.

### Component contracts

These interfaces are the coordination points for parallel implementation. Each is
implementable and testable with no knowledge of any other component.

```ts
type AudioFrame = Int16Array;
type Unsubscribe = () => void;

/** Mic capture with acoustic echo cancellation. macOS VoiceProcessingIO. */
interface AudioInput {
  start(): Promise<void>;
  stop(): Promise<void>;
  onFrame(cb: (frame: AudioFrame) => void): Unsubscribe;
}

/** Playback queue that can be silenced instantly. */
interface AudioOutput {
  enqueue(frame: AudioFrame): void;
  /** Drop all queued audio and silence within 50ms. */
  flush(): void;
  /** Milliseconds of audio actually played since the last flush. */
  playedMs(): number;
  isPlaying(): boolean;
}

/** Streaming speech-to-text. Swappable: Deepgram, Whisper, local. */
interface Transcriber {
  open(): Promise<TranscriptionStream>;
}
interface TranscriptionStream {
  push(frame: AudioFrame): void;
  onPartial(cb: (text: string) => void): Unsubscribe;
  onFinal(cb: (text: string) => void): Unsubscribe;
  close(): Promise<void>;
}

/** Decides when the user started and finished speaking. */
interface TurnDetector {
  push(frame: AudioFrame, partialText: string | null): void;
  onSpeechStart(cb: () => void): Unsubscribe;
  onTurnEnd(cb: () => void): Unsubscribe;
}

/** Streaming text-to-speech. Swappable: ElevenLabs, Cartesia, local. */
interface Voice {
  synthesize(
    text: AsyncIterable<string>,
    signal: AbortSignal,
  ): AsyncIterable<AudioFrame>;
}

/** Claude, via one long-lived CLI process, reading ~/.claude config. */
interface AgentSession {
  send(text: string, signal: AbortSignal): AsyncIterable<AgentEvent>;
  /** Tell Claude it was cut off, and with what. See §6. */
  notifyInterruption(spokenSoFar: string, userSaid: string): void;
  /** Asked before any write/execute tool runs. The Director answers by voice. See §8. */
  onPermissionRequest(
    handler: (req: PermissionRequest) => Promise<boolean>,
  ): void;
}
type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; phase: 'start' | 'end' }
  | { type: 'done' };
/** What the Director must be able to say out loud in one short line. */
interface PermissionRequest {
  tool: string;
  /** Already in spoken form per §7 — "session.ts, dentro auth", not a full path. */
  summary: string;
}

/** Turns agent output into what is worth saying out loud. See §7. */
interface SpeechFilter {
  filter(events: AsyncIterable<AgentEvent>): AsyncIterable<string>;
}

/** Additional consumers of the output audio. Avatar plugs in here. */
interface OutputSink {
  onAudio(frame: AudioFrame): void;
  onSpeechStart(): void;
  onSpeechEnd(): void;
}
```

**Swappability rule:** `Transcriber` and `Voice` are the two paid/cloud dependencies.
Nothing outside their own module may reference a provider name. Switching providers
is a config change plus one new class.

## 4. Latency budget

Time from the user falling silent to the first sound leaving the speakers.

Figures below are **measured on the target machine** with the M0 prototype
(`proto/talk.mjs`), not estimated. An earlier draft of this spec assumed 450 ms for
Claude's first token; the real figure is roughly three times that, so the honest target
is ~1.5 s rather than 1 s.

| Stage | Budget | Basis |
|---|---|---|
| Transcription | 0 ms | Runs during speech. Measured 126–215 ms when run after the fact |
| Turn end detection | 250 ms | §5, not yet measured |
| Claude first token | 1300 ms | **Measured**, warm persistent session, no MCP |
| First speakable sentence | 100 ms | SpeechFilter emits on sentence boundary |
| TTS first audio chunk | 100 ms | Cartesia Sonic-3 |
| **Total** | **~1500 ms** | Enforced by automated test, §10 (Testing) |

Three things dominate this budget, and two were discovered by measuring, not by design:

- **The session must be a single long-lived process.** Spawning per turn costs ~1 s more
  (2.4 s vs 1.37 s to first token).
- **MCP servers must load lazily.** They reconnect on every session start, and the
  user's configured servers cost **5–7 s per turn**. With them eager-loaded, no other
  optimisation matters. Not in the original design.
- **The STT model must stay resident.** Cold-loading Whisper per utterance costs 17 s
  against 0.15 s warm. `Transcriber` therefore owns a process, not a function call.

Overlap is the rest of the design. Nothing waits for a complete answer:

- The **first complete sentence** goes to TTS while Claude is still generating.
- Sentence *n+1* synthesizes while sentence *n* plays, so playback never gaps.
- If the first token has not arrived within **1200 ms** (typically because Claude is
  running tools), the Director emits a filler line — "aspetta che guardo" — through the
  same path. **Filler is a Director decision, not a Voice or Filter concern.**

  The prototype proved why. Asked to check the weather, the model was instructed to
  narrate before a slow tool call, and it did emit "aspetta che controllo" — but only
  in the same burst as the finished answer, 15 s later. A model cannot announce that it
  is thinking, because by the time it writes anything it has stopped. Only the Director
  can see 1200 ms of silence while it happens.

## 5. Turn detection

Not a silence timer. A silence timer is either slow (long timeout) or interrupts the
user mid-thought (short timeout). Both feel robotic.

Combine two signals:

- **Voice activity (VAD)** — energy/model-based speech presence per frame.
- **Transcript stability** — the partial transcript stops changing, and its content
  parses as a complete utterance.

End the turn when VAD reports silence for **250 ms** *and* the partial transcript is
stable. If VAD reports silence but the transcript looks unfinished (trailing
conjunction, mid-clause), extend to **700 ms** before ending the turn.

## 6. Barge-in and echo cancellation

### Echo cancellation is a Milestone 1 requirement, not an optimization

Without it, the microphone hears the speakers, the transcript fills with the agent's own
words, and the agent interrupts itself in a loop. The alternatives are AEC or mandatory
headphones forever, and that decision shapes daily use. Use the macOS
**VoiceProcessingIO** audio unit, which performs AEC in the OS using the playback
signal as reference.

`AudioInput` owns this. No other component is aware of echo.

### Interrupt sequence

When `TurnDetector` fires `onSpeechStart` while the Director is in `SPEAKING`:

1. `AudioOutput.flush()` — silence within 50 ms.
2. Abort the `Voice.synthesize` stream via its `AbortSignal`.
3. Abort the in-flight `AgentSession.send` stream.
4. Compute what the user actually heard: `AudioOutput.playedMs()` mapped back to
   the emitted text.
5. Transition to `HEARING`.

### Telling Claude it was cut off

Step 4 exists because of step 5's consequence. After the user's new turn is
transcribed, call `notifyInterruption(spokenSoFar, userSaid)`, which prepends a system
note to the next request stating how much of the previous answer the user actually
heard.

Without this, Claude believes its full answer was received and continues from a shared
context that does not exist. This single detail is the difference between an
interruption feeling conversational and feeling broken.

## 7. Spoken form

Claude's raw output is unspeakable: file paths become letter-by-letter spelling, code
blocks become minutes of syntax read aloud. Reading it verbatim is the actual reason
voice assistants are not used for real work — content, not timbre.

Two channels from one response: **spoken** and **shown**.

### Mechanism

Primary: a system prompt instructing Claude to open every response with a single short
spoken line, delimited, followed by the detail. Because output is streamed, that line
reaches TTS first — this *reduces* latency rather than adding any.

Backstop: `SpeechFilter` enforces the rules structurally, so a malformed response can
never dump code into the speakers.

### Rules

| Content | Spoken form |
|---|---|
| Code blocks | Never spoken. "Te l'ho scritta, guarda lo schermo." |
| File paths | Shortened: `src/auth/session.ts` → "session, dentro auth" |
| Tool activity | Narrated briefly: "sto lanciando i test" |
| Long lists | Summarized: "sette errori, il primo è…" |
| Errors, results, answers | Spoken in full — this is what the user wants |

### Speaking style

Robotic delivery comes mostly from phrasing, not synthesis. The system prompt requires
short sentences, contractions, no spoken bullet lists, no "Certainly! Here are the three
steps", and natural hesitation while working. More realism is won here than by choosing
a TTS vendor.

## 8. Tool permissions

A voice session has no surface for a permission dialog. The prototype proved the
consequence: asked to search the web, Claude hit a permission prompt that nobody could
see or answer, and the turn hung until it gave up and said "non ho il permesso attivato".
A blocked tool in voice is indistinguishable from a crash.

So permission cannot be resolved at the moment the tool is called. It must be decided
in advance, by category.

| Tool class | Examples | Policy |
|---|---|---|
| Read-only | `Read`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `ToolSearch` | Pre-approved. Never prompts |
| Write / execute | `Write`, `Edit`, `Bash`, `NotebookEdit` | Spoken confirmation required |
| Never | Anything not in the two lists above | Denied; Director speaks the refusal |

The allowlist is passed at session start (`--allowedTools` in the prototype). Read-only
tools are safe to pre-approve because their worst case is wasted time, and the user is
present and listening.

### Spoken confirmation

Write and execute tools run through a permission MCP server (`canUseTool`) that the
Director owns. When a call arrives:

1. The Director abandons whatever it was about to say and speaks the intent in one
   short line: *"vuoi che scriva su session.ts?"*
2. It transitions to `AWAITING_APPROVAL`, which listens exactly like `LISTENING` but
   routes the next transcript differently.
3. That transcript is matched against an approval grammar before it is treated as a
   normal turn.

| Heard | Result |
|---|---|
| "sì", "vai", "fallo", "ok" | Allow, once, for this call only |
| "no", "ferma", "lascia stare" | Deny; the denial reason goes back to Claude so it can adapt |
| Anything else | **Treated as denial**, and the utterance becomes the next user turn |

The third row is the important one. A misheard confirmation must never become an
accidental `yes` — Whisper hallucinates on silence (§ below), so an unrecognised sound
has to fail closed. The cost of a wrong deny is one repeated sentence; the cost of a
wrong allow is an edited file the user never asked for.

Approval is per call, never remembered. There is no "always allow" in voice, because the
user cannot see what they would be agreeing to for the rest of the session.

### Hallucinated input

Whisper emits confident text for silence — `[Musica]`, `[Applausi]`, `Sottotitoli e
revisione a cura di…` — and in the prototype this produced entire turns the user never
spoke. `Transcriber` therefore strips bracketed markers and known subtitle boilerplate,
and drops the result if under two characters. Short real words ("sì", "no", "ferma")
must survive, so the filter cannot use a minimum word count.

Under `AWAITING_APPROVAL` this matters twice over: a hallucinated utterance reaching the
approval grammar is exactly the failure the fail-closed rule exists to stop.

## 9. Error handling

Voice has no error screen. Every failure must either recover silently or be spoken.

| Failure | Behaviour |
|---|---|
| TTS stream drops mid-sentence | Retry once; on second failure speak a short apology line via the fallback voice |
| STT disconnects | Reconnect with backoff; speak "non ti ho sentito, ripeti" if a turn was lost |
| Claude errors or rate-limits | Speak the reason briefly; stay in `LISTENING` |
| Mic device disappears | Stop, speak once, retry every 2 s |
| API key missing | Fail at startup with a terminal error, never at first speech |

Rule: **never fail silently into a dead microphone.** A voice agent that stops
responding is indistinguishable from one that is thinking.

## 10. Testing

Physical audio is replaced at the edges: `AudioInput` is fed a WAV file, `AudioOutput`
records to a buffer. Everything between is ordinary testable code.

Three tests carry most of the value:

1. **Latency** — feed a WAV, measure to first output frame, assert < 1500 ms (§4).
2. **Barge-in** — start playback, inject speech at t=500 ms, assert output silent within
   50 ms and that `notifyInterruption` received the correct heard-prefix.
3. **Director** — the state machine alone against fakes for all seven other components.
   This is where the real bugs live.
4. **Fail-closed approval** — in `AWAITING_APPROVAL`, feed a hallucinated
   transcript and assert the tool call is denied, not allowed (§8).

Plus: an **echo loopback test** feeding `AudioOutput` back into `AudioInput` to assert
the agent does not interrupt itself. TDD throughout.

## 11. Milestones

**M1 — the loop.** mic → Claude → voice, with AEC and barge-in. Launched as
`axa-voice`. No avatar, no wake word, no plugin. This either works or the project does
not exist.

**M2 — plugin wrapper.** Installable plugin exposing `/voice` to launch the app.

**M3 — avatar on the monitor.** An `OutputSink` driving a 3D head with visemes from the
audio stream.

**M4 — holographic output.** Same sink, different display. Hardware chosen once M3 shows
what it must display; the software does not change.

### Parallelizable work in M1

The five leaf components share no state and are defined entirely by §3 interfaces, so
they can be built simultaneously by separate agents:

```
AudioInput+AEC │ Transcriber │ AgentSession │ Voice │ AudioOutput
───────────────┴─────────────┴──────────────┴───────┴────────────
                             ▼
                    Director  (single-threaded, by hand)
                             ▼
                        SpeechFilter
```

The Director is written by hand after the leaves land. It is the only component with
real logic, and debugging a subtle state-machine bug authored elsewhere while five other
components are also new is the worst possible trade.

## 12. Stack

- TypeScript, Node.js.
- Claude via the CLI in streaming stream-json mode, one long-lived process, reading
  `~/.claude/`. MCP servers loaded lazily, never at session start (§4).
- **Cartesia Sonic-3** for TTS. Note that `sonic-2` and every earlier model ID now
  return HTTP 400 "Model sunsetted"; only `sonic-3` is live. ElevenLabs Flash remains a
  drop-in alternative behind the same `Voice` interface (§3).
- macOS VoiceProcessingIO for capture and AEC.
- **whisper.cpp** for STT, run as a resident `whisper-server` process, not a per-utterance
  invocation (§4). Measured 126–215 ms warm against 17 s cold. Deepgram stays available
  behind the same `Transcriber` interface if §5 turns out to need word-level streaming
  partials that local Whisper cannot provide.

## 13. Decisions made

| Question | Decision | Reason |
|---|---|---|
| Plugin or standalone app? | Standalone, packaged as a plugin later | Plugins cannot receive voice input (§2) |
| Which TTS? | Cartesia Sonic-3, behind an interface | User supplied the key; ElevenLabs stays a drop-in swap |
| AEC now or later? | Now, in M1 | Determines whether headphones are mandatory forever |
| Read code aloud? | Never | Unusable within 30 seconds |
| Wake word? | Not in scope | Desk use, session-scoped |
| Buy holographic hardware now? | No | The avatar is a video; choose the display once there is something to show |
| Which STT? | Local whisper.cpp, resident process | Measured fast enough (126–215 ms) and free; Deepgram stays available |
| Tool permissions in voice? | Read always, write on spoken "sì" | No permission dialog exists in voice; a blocked turn hangs invisibly (§8) |
| Misheard confirmation? | Fail closed — anything but a clear yes is a deny | Whisper hallucinates on silence; a wrong allow edits files unasked |
| Remember an approval? | Never; per call only | The user cannot see what they would be agreeing to |
