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

1. **Time to first sound** under ~1.3 s (Siri: ~2 s), measured end to end (§4).
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

An earlier draft specified 16 kHz capture and 24 kHz playback. **That combination cannot
be built**, and the reason shapes the architecture — see "One device, not two" below.
VoiceProcessingIO requires both client scopes to run at the *same* sample rate;
initialization fails with `-10875` on every off-diagonal pair, and the constraint holds
even when one direction is disabled.

So:

- **The audio unit runs at 24 kHz, mono, PCM16, on both scopes.** TTS audio reaches the
  speaker with zero resampling.
- **Capture is resampled 24 k → 16 k inside the Swift helper**, on its writer thread,
  never on the render thread. A clean 2:3 ratio. Not in Node: a CPU-bound resample loop
  on the event loop that also feeds the audio device is how you get dropouts.
- Everything above the helper still sees 16 kHz, mono, PCM16, 20 ms frames (320 samples).
- `AudioFrame = Int16Array`.

PCM16 is accepted by the unit — Float32 is not required. But note that
`AudioUnitSetProperty` **returns `noErr` for formats the unit will not accept**; the
failure surfaces later at `AudioUnitInitialize`. Check the initializer's return, not the
setters'.

### One device, not two

`AudioInput` and `AudioOutput` are two interfaces over **one object**, backed by one
`AUVoiceProcessor` instance: bus 1 is the microphone, bus 0 is the speaker. They are
separate interfaces because the Director should not care, and because tests fake them
independently. They are **not** separate implementations and must not be built as
separate workstreams (§11).

This is forced, not chosen. AEC works by using the playback signal as its reference, so
the playback path has to run through the same unit as capture; and the shared-sample-rate
constraint above means even a disabled direction still has to be configured.

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

/** Playback queue that can be silenced instantly. Same device as AudioInput. */
interface AudioOutput {
  enqueue(frame: AudioFrame): void;
  /**
   * Drop all queued audio and silence within 50ms. Resolves with the
   * milliseconds the user actually HEARD — which is less than the audio handed
   * to the device, because some of it was still in the hardware pipeline.
   */
  flush(): Promise<{ heardMs: number }>;
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

/** Claude, via one long-lived Agent SDK session, reading ~/.claude config. */
interface AgentSession {
  send(text: string): AsyncIterable<AgentEvent>;
  /**
   * Stop the turn in flight and keep the session usable. NOT an AbortSignal:
   * aborting tears the session down and is not instant (§6).
   */
  interrupt(): Promise<void>;
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

Figures below are **measured on the target machine**, not estimated. The scripts that
produced them live in `proto/` and are the instruments, not the architecture.

| Stage | Budget | Basis |
|---|---|---|
| Transcription | 0 ms | Runs during speech. Measured 126–215 ms when run after the fact |
| Turn end detection | 250 ms | §5, not yet measured |
| Claude first token | 800 ms | **Measured**, median of 8 warm turns (`proto/check-ttft.mjs`) |
| First speakable sentence | 100 ms | SpeechFilter emits on sentence boundary |
| TTS first audio chunk | 150 ms | **Measured**, Cartesia WebSocket, median of 9 runs |
| **Total** | **~1300 ms** | Enforced by automated test, §10 (Testing) |

### Measure turn N, never turn 1

The first attempt at the first-token number produced **7040 ms**, and it was wrong in a
way worth recording, because the automated latency test can make the identical mistake.

It measured one turn in a fresh session. That turn pays for process spawn, config load
and system-prompt processing — costs the user pays **once at launch**, not on every
sentence they speak. Measured across four turns in one live session, first token settles
at **672–999 ms** (median ~750), and the spread between turn 1 and turn 4 within a
session is itself visible: turn 1 runs ~100 ms slower than the ones after it.

So the latency test must warm the session, discard the first turn, and assert on the
steady state. A test written the obvious way would have reported a 7 s system and sent
someone off to optimise something that was never slow.

Two consequences for the design:

- `startup()` pre-warms the subprocess in **~900 ms**. That must happen while the app is
  launching, before the user can speak, or it lands on the first turn.
- An earlier draft of this spec guessed 450 ms for first token. The prototype's raw CLI
  path measured 1300 ms. The SDK path measures ~800 ms. The gap between the last two is
  not yet explained — pre-warming is the likely cause but it was not isolated — so 800 ms
  is recorded as observed, not as understood.

The TTS figure is a median because the spread is wide: 82–378 ms across nine runs
(`proto/check-cartesia-ws.mjs`). Crucially, the spread does **not** track the model —
`sonic-3`, `sonic-3.5` and `sonic-3.6` are indistinguishable once you run each more than
once, so the model is chosen for voice quality and the variance is network jitter. The
budget carries 150 ms and the design absorbs the tail by never blocking on it: playback
starts on the first chunk, and sentence *n+1* is already synthesizing.

`Voice` must use the **WebSocket** endpoint (`wss://api.cartesia.ai/tts/websocket`), not
`/tts/bytes` as the prototype did. The WebSocket takes incremental `transcript` chunks
under one `context_id` with `continue: true`, which is exactly the shape `SpeechFilter`
emits — sentences arriving one at a time — and it returns audio before the text is
finished. `/tts/bytes` cannot start until the whole sentence exists.

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
- **While waiting for the first token, the Director says nothing.** A filler line —
  "aspetta che guardo" after 1200 ms — was implemented and then removed: it fired on
  nearly every turn, because a long first sentence trails its first token by more than
  any fixed timer, so the user was talked over mid-answer on an ordinary question.
  Being interrupted is worse than a moment of silence. The prototype had already shown
  the model cannot narrate its own thinking (it emits "aspetta che controllo" only in
  the same burst as the finished answer, 15 s later), and a Director timer turned out
  to be the wrong instrument too. Long waits are covered only where they are real and
  namable: a tool call (§4, `progress.ts`), which the Director can see start and end.

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

### Partials come from re-transcription, not streaming

`whisper-server` has exactly three routes — `/health`, `/load`, `/inference` — and no
SSE or WebSocket anywhere in the binary. There is no streaming transcript. Partials are
produced by re-transcribing a growing buffer on a timer.

Measured, this is affordable: at a **350 ms cadence** a sustained loop runs p50 167 ms
(2 s buffer) to 220 ms (4 s buffer) with **zero overruns** and ~20 % of one core, because
inference runs on the Metal GPU. Two settings make it comfortable:

- **`audio_ctx=1000` for partials, `0` for the final.** Shrinking the encoder context is
  ~25 % faster with no transcript change in testing. At 500 the transcript degrades.
- **Cap the window.** Cost grows with buffer length (10 s ⇒ ~300 ms), so beyond ~6 s
  either pin the earlier text and re-transcribe only the tail, or drop the cadence
  to 500 ms.

### Compare the stable prefix, not the whole string

This is the detail that decides whether turn detection works at all. Whisper **truncates
or invents the last word of a growing buffer** — the same utterance yielded "mi serve sa",
then "Erichino", then "di Erie" on successive passes. A stability check that diffs the
full string sees the tail churn on every pass and **never converges**, so the turn never
ends.

`TurnDetector` therefore drops the final one to two tokens before comparing. Measured
partials show the prefix going stable several passes before the tail does:

```
2.5s  "Ciao, puoi controllare i log di ieri per favore?"
3.0s  "Ciao, puoi controllare i log di ieri per favore?"   ← prefix stable, turn can end
3.5s  "Ciao, puoi controllare i log di ieri per favore, mi serve sa"
```

### One engine, one inference at a time

`whisper-server` serializes: two concurrent requests take 202 ms and 446 ms, four take up
to 936 ms — latency stacks linearly. The partial loop and the final transcription
therefore contend, and a running loop delays the final transcript by a measured **+76 ms**
(203 → 279 ms).

Stop issuing partials the moment the endpointer fires. If that is not enough, run two
servers on two ports — one for partials, one for finals — at ~500 MB each.

## 6. Barge-in and echo cancellation

### Echo cancellation is a Milestone 1 requirement, not an optimization

Without it, the microphone hears the speakers, the transcript fills with the agent's own
words, and the agent interrupts itself in a loop. The alternatives are AEC or mandatory
headphones forever, and that decision shapes daily use. Use the macOS
**VoiceProcessingIO** audio unit, which performs AEC in the OS using the playback
signal as reference.

`AudioInput` owns this. No other component is aware of echo.

**Verified working on the target machine.** A probe tone played through the render bus
while measuring its level in the captured microphone stream, with AGC off and the tone
frequency hopping so that noise suppression could not account for the result:

| | 440 Hz | 1320 Hz | steady tone |
|---|---|---|---|
| AEC on | +10.4 dB | +15.6 dB | +0.7 dB |
| AEC bypassed | +29.6 dB | +32.3 dB | +24.4 dB |

An undocumented bonus, measured but not to be relied on: VPIO also attenuated audio from
a *separate* process (`afplay`, +33.1 dB bypassed vs −7.2 dB with AEC on), which suggests
the OS references the whole device output mix rather than only our render bus. Route
playback through the unit regardless — the render callback's frame counter is needed for
`heardMs` either way.

### Microphone permission

A plain `swiftc`-built binary with no bundle identifier **does** get microphone access and
delivers real audio; TCC attributes the request to the responsible process (the terminal
in development, the packaged app in production).

But there is a trap that hangs the app forever: when the helper is not parented by a GUI
process, `AVCaptureDevice.requestAccess(for: .audio)` **never calls back at all** — no
dialog, no timeout, no error. **Never gate startup on `requestAccess`.** Start audio and
observe whether samples arrive.

Because a TCC denial delivers digital silence, which is indistinguishable from a quiet
room, the helper runs a **silence watchdog**: if every sample is exactly zero for ~2 s, it
reports a permission error rather than listening to nothing forever (§9).

Harden the helper by embedding an `Info.plist` at link time — verified to work, and no
`.app` bundle is required:

```sh
swiftc -O aecio.swift -o aecio \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Helper-Info.plist
```

Ship `NSMicrophoneUsageDescription` in the **parent** app, since that is what the user is
actually granting.

### Interrupt sequence

When `TurnDetector` fires `onSpeechStart` while the Director is in `SPEAKING`:

1. `AudioOutput.flush()` — silence within 50 ms, and it returns `heardMs` for step 4.
2. Abort the `Voice.synthesize` stream via its `AbortSignal`.
3. `AgentSession.interrupt()` — **not** an abort. In the Agent SDK, aborting the
   controller tears the session down and is not even prompt: the signal reaches the
   subprocess only after a graceful-close path with a ~2 s grace window. `interrupt()`
   stops the turn and leaves the session reusable, which is what barge-in needs.
4. Map the `heardMs` returned by step 1 back to the emitted text.
5. Transition to `HEARING`.

**Measured: this budget is met with room to spare.** Reaction inside the render callback
is 8.8 ms and the flush acknowledgement reaches Node in 10 ms. The audio unavoidably in
flight is the committed hardware buffer — 27.3 ms at the default settings — for a total
of about **36 ms**, against the 50 ms target. Dropping `BufferFrameSize` to 256 frames
brings it to ~25 ms if margin is wanted.

The queued audio costs nothing: the ring buffer is discarded in O(1) by moving the read
index, measured to drop 20–80 ms of backlog in a single callback.

**`MaximumFramesPerSlice` must be left at its 512 default.** Raising it to 4096 makes
VPIO batch its callbacks into 2048-frame blocks every 85 ms, and flush reaction degrades
to 85 ms — blowing the target on its own. `BufferFrameSize` does *not* fix this; only the
slice size controls it. This is the single easiest way to silently break barge-in:

| MaximumFramesPerSlice | Callback gap | Flush reaction |
|---|---|---|
| 4096 | 85.4 ms | up to 85 ms |
| **512 (default)** | **10.7 ms** | **2.3 ms** |
| 256 | 5.4 ms | 0.9 ms |

### Counting what was actually heard

`kAudioUnitProperty_Latency` reports **0.0 ms** on this unit and cannot be used. Instead
the helper counts frames actually consumed by the render callback (never counting
zero-fill) and subtracts the device pipeline:

```
heardMs = (framesConsumed − outputLatencyFrames) / sampleRate × 1000
```

`outputLatencyFrames` is composed from device properties — device latency, safety offset,
buffer size and stream latency — and came to 655 frames at 24 kHz on the test machine.
Frames handed to the unit but still inside the hardware were never heard by the user, and
telling Claude it was cut off later than it was is exactly the error §6 exists to prevent.

`interrupt()` returns a receipt listing turns still queued to run. The Director must
drain those before returning to `LISTENING`, or the agent resumes speaking about the
thing the user just interrupted.

### Barge-in is scoped to `SPEAKING`

The sequence above applies **only** while the Director is `SPEAKING`. Speech during
`THINKING` is not an interruption: it is captured, and the transcript is routed by state
when the turn ends. Capture is therefore independent of `#state` — `THINKING` stays
`THINKING` while the user is being recorded, and the state machine gains no fifth state.

- A **bare stop command** — `basta`, `stop`, `lascia stare`, `lascia perdere`, `annulla`,
  `annullalo`, `ferma`, `fermati`, `fermo`, but deliberately **not** `aspetta` — cancels
  the turn via `interrupt()`. It is a whole-utterance match only, so the same word inside
  a longer sentence (`"non dirmi basta"`) stops nothing.
- **Anything else** is queued and answered once the current answer completes, as if
  freshly spoken. Talking while it works adds to the conversation instead of destroying
  the work — the opposite of the behaviour that motivated this amendment.

The waiting model as a whole is specified in
[2026-09-12-interruption-model-design.md](2026-09-12-interruption-model-design.md).

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

### The permission prompt must time out

The Agent SDK's permission callback **has no deadline of its own**: if the handler never
resolves, the tool stays blocked and the session waits forever. In a text UI that is
fine, because the prompt sits on screen until someone answers. In a voice UI the user can
simply walk away, and the failure is invisible — a silent agent is indistinguishable from
a thinking one (§9).

So the Director starts a **10 s timer** when it asks. On expiry it denies, says so out
loud ("lascio stare, non ho sentito"), and returns to `LISTENING`. This is the same
fail-closed rule as a misheard answer, applied to no answer at all.

### Say the SDK's own sentence

The permission callback supplies a pre-rendered `title` — "Claude wants to read foo.txt"
— and a short `displayName`. Use `title` as the basis for the spoken line rather than
reconstructing one from the tool name and its raw input. It already accounts for tools
whose arguments do not read back sensibly, and it is maintained upstream. Pass it through
the §7 spoken-form rules (path shortening) before speaking.

### Not every tool can be pre-approved

`allowedTools` suppresses the permission callback for the tools it names — this is what
makes the read-only tier work. But a small set of sensitive actions reaches the callback
regardless of any allow rule. The Director must therefore treat a permission request for
a *read-only* tool as possible, not as a bug, and handle it with the same spoken
confirmation rather than asserting it cannot happen.

### Hallucinated input

Whisper emits confident text for silence — `[Musica]`, `[Applausi]`, `Sottotitoli e
revisione a cura di…` — and in the prototype this produced entire turns the user never
spoke. Every model size does it, from `base` to `large-v3-turbo`.

**The decoder cannot be talked out of it.** Measured against 2 s of digital silence, every
threshold knob is a no-op, and `--suppress-nst` actively makes things *worse* — it bans
bracketed tokens, so the model routes the identical hallucination through ordinary words
instead:

| Setting | Result on silence |
|---|---|
| baseline | `[Musica]` |
| `suppress_nst=true` | `Sottotitoli e revisione a cura di QTSS` |
| `no_speech_thold` 0.2 / 0.05 | `[Musica]` |
| `logprob_thold`, `entropy_thold`, no-fallback | `[Musica]` |

**Silero VAD at the server fixes it at the source**, and is close to free: run
`whisper-server --vad --vad-model ggml-silero-v5.1.2.bin`. Silence then returns `""` in
**3–5 ms** because whisper never runs, against 128 ms of confabulation without it. Real
speech is unaffected — measured identical transcripts and no latency penalty. For the
partial loop of §5 this is a double win: silent partials cost 4 ms instead of 130 ms.

The regex filter stays as a second line of defence. VAD gates on speechiness, so a cough
or a keyboard clack still reaches the decoder and still becomes a sentence. It strips
bracketed markers and subtitle boilerplate, and drops anything under two characters —
never a minimum *word* count, because "sì", "no" and "ferma" are the whole vocabulary of
§8's approval grammar.

**Do not gate on `no_speech_prob`.** In whisper.cpp 1.9.2 it is off by one request — it
reports the *previous* request's value — and on these samples it is inverted as well
(silence 0.0001, speech 0.945). It looks exactly like the right signal and is unusable.

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
| Mic returns pure digital silence for 2 s | Report a permission error. TCC denial is indistinguishable from a quiet room (§6) |
| API key missing | Fail at startup with a terminal error, never at first speech |
| VAD model missing | Fail at startup. Degrading to no-VAD means inventing user turns (§8) |
| Port 8178 already bound | Fail at startup. macOS allows a second bind and splits traffic |

Rule: **never fail silently into a dead microphone.** A voice agent that stops
responding is indistinguishable from one that is thinking.

## 10. Testing

Physical audio is replaced at the edges: `AudioInput` is fed a WAV file, `AudioOutput`
records to a buffer. Everything between is ordinary testable code.

Three tests carry most of the value:

1. **Latency** — feed a WAV, measure to first output frame, assert < 1300 ms (§4).
   Warm the session and **discard the first turn**; asserting on turn 1 measures startup
   cost and reports ~7 s (§4).
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

An earlier draft listed **five** parallel leaves, splitting `AudioInput` from
`AudioOutput`. That split is impossible: they are one audio unit (§3). Two agents given
those as separate tasks would have produced two `AUVoiceProcessor` instances that cannot
coexist on one device, and the failure would have surfaced only at integration.

Four leaves, then:

```
AudioDevice (in+out+AEC) │ Transcriber │ AgentSession │ Voice
─────────────────────────┴─────────────┴──────────────┴──────
                             ▼
                    Director  (single-threaded, by hand)
                             ▼
                        SpeechFilter
```

`AudioDevice` is also the largest and riskiest of the four — it is the Swift helper plus
its wire protocol — so it should start first rather than being sized as one leaf among
equals.

The Director is written by hand after the leaves land. It is the only component with
real logic, and debugging a subtle state-machine bug authored elsewhere while five other
components are also new is the worst possible trade.

## 12. Stack

- TypeScript, Node.js 22 (ESM — the SDK ships ESM only).
- Claude via **`@anthropic-ai/claude-agent-sdk`**, one long-lived session in streaming
  input mode, pre-warmed with `startup()` so process spawn is off the critical path.

  Session options are load-bearing for §4 and must be set explicitly:

  | Option | Value | Why |
  |---|---|---|
  | `strictMcpConfig` | `true` | Ignores project, user, and plugin MCP config |
  | `mcpServers` | `{}` | Nothing to connect — removes the 5–7 s/turn cost |
  | `settingSources` | `['user']` | Keeps the user's skills and agents from `~/.claude/` |
  | `includePartialMessages` | `true` | Token deltas; without it, text arrives in blocks |
  | `systemPrompt` | `{type:'preset', preset:'claude_code', append: …}` | A bare string **replaces** the preset rather than appending |

  `settingSources` now defaults to loading **all** sources, so omitting it silently
  restores the user's MCP servers and the latency with them. It must be written out.

  Stream deltas are emitted for the main session only — **subagent output arrives as
  whole messages**, so any turn that dispatches a subagent will speak in one late burst
  rather than streaming (§4).
- **Cartesia** for TTS over the WebSocket endpoint, `cartesia_version: 2026-08-14`.
  `sonic-3`, `sonic-3.5` and `sonic-3.6` are all live and measurably equal in latency
  (§4), so pick on voice quality; `sonic-2` and earlier return HTTP 400 "Model
  sunsetted". ElevenLabs Flash remains a drop-in alternative behind `Voice` (§3).
- macOS **VoiceProcessingIO** for capture, playback and AEC, in a small Swift helper
  binary that Node spawns and talks to over pipes. Wire protocol: stdin takes framed
  commands (`audio`, `flush`, `quit`), stdout is raw PCM16 mono, stderr is one JSON event
  per line. The ring buffers are lock-free SPSC; the render and input callbacks never
  allocate, lock, or do I/O.

  **Prerequisite:** a consistent Swift toolchain. On the target machine today, Command
  Line Tools alone is internally inconsistent — a stale `module.modulemap` collides with
  `bridging.modulemap`, and the CLT compiler build does not match the CLT SDK, so every
  SDK overlay (`Foundation`, `AudioToolbox`, `CoreAudio`) fails to import. Installing
  Xcode, or reinstalling Command Line Tools, fixes it. **This must be resolved before
  `AudioDevice` work starts**, or the first task stalls on a toolchain problem that looks
  like a code problem.
- **whisper.cpp** for STT (`whisper-cpp` 1.9.2), run as a resident `whisper-server`,
  not a per-utterance invocation (§4). Measured 126–215 ms warm against 17 s cold.
  Inference runs on the **Metal GPU**, so thread count barely matters and the cost is
  ~20 % of one core, not of all of them.

  ```
  whisper-server -m ggml-small.bin --port 8178 -l it \
                 --vad --vad-model ggml-silero-v5.1.2.bin
  ```

  - **`ggml-small`** is the right size. Measured on conversational Italian, `medium` is
    2.6× slower and `large-v3-turbo` 3.5× slower for no visible quality gain, and the
    turbo models are encoder-bound (~450–550 ms regardless of buffer length), which makes
    them a *worse* fit for a partial loop than their headline numbers suggest. Quantizing
    turbo does not help — q5_0 measured marginally slower than f16.
  - The **Silero VAD model is not bundled** with homebrew and must be fetched once
    (885 KB) from `huggingface.co/ggml-org/whisper-vad`. Startup must fail loudly if it
    is missing (§9), because without it the agent answers questions nobody asked.
  - `POST /inference`, `multipart/form-data`, field name exactly **`file`**, and the
    payload must be a **container — raw PCM is rejected**. Feed 16 kHz mono s16 WAV.
    Health-check `GET /health` before use: two `whisper-server` processes can both bind
    the same port on macOS with no error, and the kernel then splits requests between
    them, which silently corrupted a full round of measurements during this research.

  Deepgram stays available behind the same `Transcriber` interface.

## 13. Decisions made

| Question | Decision | Reason |
|---|---|---|
| Plugin or standalone app? | Standalone, packaged as a plugin later | Plugins cannot receive voice input (§2) |
| Which TTS? | Cartesia Sonic-3, behind an interface | User supplied the key; ElevenLabs stays a drop-in swap |
| AEC now or later? | Now, in M1 | Determines whether headphones are mandatory forever |
| Capture and playback separate? | **No — one audio unit, one task** | VPIO refuses mismatched client rates; AEC needs the playback as reference (§3) |
| Sample rate? | 24 kHz both scopes, resample to 16 k in the helper | The 16 k/24 k split in the first draft does not initialize |
| Read code aloud? | Never | Unusable within 30 seconds |
| Wake word? | Not in scope | Desk use, session-scoped |
| Buy holographic hardware now? | No | The avatar is a video; choose the display once there is something to show |
| Which STT? | Local whisper.cpp `small`, resident | Measured fast enough (126–215 ms) and free; bigger models are slower, not better |
| Stop the silence hallucinations how? | Silero VAD at the server | The only thing that worked; decoder thresholds are no-ops and `suppress-nst` backfires |
| Streaming partials? | Re-transcribe a growing buffer at 350 ms | whisper-server has no streaming route; measured affordable with `audio_ctx=1000` |
| Tool permissions in voice? | Read always, write on spoken "sì" | No permission dialog exists in voice; a blocked turn hangs invisibly (§8) |
| Misheard confirmation? | Fail closed — anything but a clear yes is a deny | Whisper hallucinates on silence; a wrong allow edits files unasked |
| No answer at all? | Deny after 10 s | The SDK's permission callback never times out on its own |
| Stop a turn mid-flight? | `interrupt()`, never `abort()` | Abort kills the session and takes ~2 s; interrupt is instant and reusable |
| Remember an approval? | Never; per call only | The user cannot see what they would be agreeing to |
