# axa-voice — Panel UI Design

**Date:** 2026-09-14
**Status:** Approved in brainstorming, pending implementation plan.
**Supersedes nothing.** Extends the M1 design (`2026-09-11-voice-agent-design.md`) and the
interruption model (`2026-09-12-interruption-model-design.md`).

## In breve (IT)

Oggi l'app è **solo audio**: non mostra niente a schermo. Questo documento progetta il
pannello — un widget audio con il livello del microfono, un pannello conversazione che
mostra anche il codice che a voce non si può leggere, e un cassetto di diagnostica che
mostra **il prompt che parte davvero verso Claude**. Più i comandi: pausa (che molla il
microfono davvero), "zitto", e "nuova conversazione".

---

## 1. Why

Three defects, all live today.

**The app lies to the user.** `speech-filter.ts` replaces every code block with
`" Te l'ho scritta, guarda lo schermo. "`. Nothing is ever written to any screen. The
agent directs the user's attention to a surface that does not exist.

**The prompt is invisible.** `#ask()` prepends the interruption note to the user's
words before sending:

```
[L'utente ti ha interrotto. Ha sentito solo: "…"] Ha detto: …
```

That note decides how Claude answers, and nobody can see it. The entire interruption
model shipped in M1 is evaluated by reading that line — and it is unreadable.

**The microphone is always open, with no off switch.** There is no way to stop the agent
from answering while the user talks to somebody else in the room. This is the defect with
the highest human cost: it is a hot microphone in a room with other people.

A secondary goal, weighted but not urgent: the event channel designed here is the same
channel that will drive the 3D avatar and, later, the holographic projection. Getting its
shape right now avoids rebuilding it then.

## 2. Scope

In scope:

- A browser panel served from the app: audio widget, conversation panel, debug drawer.
- Control commands: pause / resume / stop-speaking / new-conversation.
- A typed event channel out of the Director, replacing the string `debug` hook.
- Rendering of artifacts Claude produces (code, SVG, images), with sandboxing.
- Spoken lifecycle lines: greeting on start, "sono tornato" on resume.

Out of scope, deliberately:

- A global system hotkey for pause. The panel's spacebar is enough; a system-wide hotkey
  is a separate concern with its own permission story.
- A wake word ("axa, ci sei?"). It would require whisper to keep running while paused,
  which contradicts the hard-stop guarantee in §4.
- Input from the panel: no typing at the agent. This is a voice app; the panel displays
  and controls, it does not become a chat box.
- Full Markdown rendering, interactive artifacts, and any execution of agent-produced
  code. See §7.

## 3. The event channel

### 3.1 Replacing `debug`

`DirectorDeps.debug?: (message: string) => void` is **replaced**, not supplemented, by:

```ts
onEvent?: (event: DirectorEvent) => void;
```

The Director has four trace sites today (`#setState`, `#bargeIn`, `#ask`, the tool
bracket in `#run`). They emit strings. They become typed events. `cli.ts` keeps printing
them to `console.error` behind `AXA_DEBUG`; the panel renders the same events.

One source of truth, two renderings. A trace added later appears in both for free.

### 3.2 The event type

In `src/types.ts`:

```ts
export type DirectorEvent =
  | { type: 'state'; from: DirectorState; to: DirectorState }
  | { type: 'mic'; state: 'live' | 'paused' }
  | { type: 'heard'; text: string }
  | { type: 'prompt'; text: string; note?: string }
  | { type: 'said'; text: string }
  | { type: 'aside'; text: string }
  | { type: 'code'; language?: string; text: string }
  | { type: 'artifact'; path: string; kind: 'svg' | 'image' | 'html' | 'other' }
  | { type: 'tool'; name: string; phase: 'start' | 'end'; detail?: string }
  | { type: 'approval'; summary: string; verdict?: 'yes' | 'no' | 'unclear' }
  | { type: 'bargein'; heardMs: number; prefix: string }
  | { type: 'level'; mic: number; out: number }
  | { type: 'error'; message: string };
```

Three properties are load-bearing:

**`prompt` carries `note` separately from `text`.** Concatenating them — which is what
`#ask()` does before sending — makes them indistinguishable, and telling them apart is
the whole purpose of the debug drawer.

**`code` originates in the filter, not the Director.** `SentenceSpeechFilter` owns the
`inCode` state machine and is the only component that knows where a code block starts and
ends. Today it discards the content; it must hand it over. The Director forwards it.

**`aside` is distinct from `said`.** The codebase already draws this line for barge-in
accounting (`#asideMs`, `#asideSpans`): what Claude says and what the Director says are
not the same voice. The panel must not present them as one.

`tool.detail` is a short human-readable string, not a dump of the arguments: the file path
for `Write`/`Edit` (available from `canUseTool`, see §7.1), absent otherwise. It is
displayed, so §7 of the M1 spec applies to what may appear there — but only to the
*spoken* channel, never here: the panel is exactly where a full path belongs.

### 3.3 Delivery guarantees

`#publish` is synchronous and non-blocking. It awaits nothing and catches nothing —
a subscriber that throws must not take a voice turn down with it, so the Director wraps
each call and routes a failure to `onError`.

A slow or absent panel must never slow a turn. This is not a nicety: the whole product
is a 1.3 s latency budget.

### 3.4 Levels are ephemeral

`level` events are produced at ~20 Hz from the RMS of the audio frames. They are
**excluded from the history buffer** of §5. At 20 events per second they would evict the
entire conversation from a 200-entry ring in ten seconds.

They also get a decay envelope: bars driven directly by per-frame RMS at 50 Hz flicker and
read as noise. A falling-edge smoothing makes the level legible.

## 4. Commands and lifecycle

Four public methods on `Director`. Public deliberately: the same command must be
reachable tomorrow from a key, a spoken phrase, or the avatar, without rewriting anything.

```ts
async pause(): Promise<void>
async resume(): Promise<void>
stopSpeaking(): void
async newConversation(): Promise<void>
```

### 4.1 The microphone is its own axis

A new field `#mic: 'live' | 'paused'`, orthogonal to `#state`.

They must not be fused. Pausing mid-answer lets the answer finish (§4.2), so the
microphone is already `paused` while the state is still `SPEAKING`. This codebase learned
this lesson once already: `#capturing` was decoupled from `#state` in the interruption
model precisely because fusing them produced routing bugs. The same reasoning applies.

### 4.2 `pause()` — a hard stop

In order:

1. Set `#mic = 'paused'` and publish. The panel reflects it **before** any awaiting, so
   the UI never lags the user's click.
2. If an answer is in flight, let it finish. Cutting the agent off mid-sentence because
   the user pressed pause is unpleasant; `stopSpeaking()` exists for cutting.
3. Resolve any pending approval as a denial. Leaving it armed means hearing
   *"Va bene, lascio stare"* ten seconds later, into an empty room.
4. Close the transcription stream.
5. `audioIn.stop()`.

Step 5 is what makes this a hard stop: the helper releases the device and **macOS turns
off the orange microphone indicator**. That indicator is the user's evidence. A soft mute
would be a promise in a README; this is verifiable.

### 4.3 `resume()`

Reopens the device and the transcription stream, sets `#mic = 'live'`, and speaks
*"Sono tornato."*

If `audioIn.start()` fails, the failure is spoken and published. A resume that silently
did not resume is indistinguishable from one that worked — the exact failure shape §9 of
the M1 spec exists to prevent.

The Claude session is **never touched** by pause or resume. Context survives; the user
picks up where they left off.

### 4.4 `stopSpeaking()`

Cuts the answer in flight. Equivalent to saying *"basta"*. The machinery exists
(`#bargeIn`, `isStopCommand`); this exposes it.

Disabled in the UI when nothing is being spoken.

### 4.5 `newConversation()`

Clears Claude's context.

**Verified against the SDK:** `Query` exposes no `clearConversation()`. But `/clear` is a
first-class slash command — the SDK defines `SDKConversationResetMessage`
(*"Emitted by /clear, plan-mode exit, and fresh-session flows"*), carrying a
`new_conversation_id`, and `SDKResultSuccess` carries `local_command`. Slash commands flow
through the normal turn path and produce a recognisable message.

So: push `/clear` into the input stream and await `conversation_reset`. This costs an
empty turn and **keeps the session warm**.

Fallback: if the message does not arrive within a bounded wait — an older CLI that does
not emit it — rebuild `ClaudeAgentSession`, paying the ~900 ms startup. Acceptable on an
explicit, rare, user-initiated action.

Either way it then speaks the full greeting.

### 4.6 Spoken lifecycle

| Moment | Line |
|---|---|
| Startup | *"Ciao, sono Axa. Come posso aiutarti?"* |
| After `resume()` | *"Sono tornato."* |
| After `newConversation()` | the full greeting again |

All three go through `#say`, so they are `aside`: they never enter `#spoken`, never move
`#answerFromMs`, and never corrupt the interruption note. The machinery is already correct
for this.

The startup line replaces `console.log('pronto. parla pure.')` — today a message on a
terminal the user is not looking at, in an app whose entire premise is not looking at the
terminal.

**Always starts listening**, never paused. A voice agent that boots mute reads as broken.

## 5. The server

`src/panel/server.ts`, on `node:http`. **Zero dependencies**, consistent with the project
(no build step; HTML/CSS/JS served as-is from `src/panel/public/`).

| Route | Purpose |
|---|---|
| `GET /` | the page |
| `GET /events` | SSE stream of `DirectorEvent` |
| `POST /command` | `{"cmd":"pause"}` → the matching method |
| `GET /file` | whitelisted artifact serving (§7) |

**Port 8179**, beside whisper's 8178, with the same preflight: if it is taken, fail at
startup with a sentence that says so. `stt/server.ts` already documents why — a second
process silently splitting traffic is a debugging nightmare.

**Binds to `127.0.0.1` only.** Never `0.0.0.0`. Conversations and prompts travel this
port.

**A ring buffer of the last ~200 non-`level` events.** Open the tab late, or reload, and
the conversation is still there. `EventSource` reconnects on its own and sends
`Last-Event-ID`; the server replays from there. Without this the panel is unusable after
the first refresh.

**With no client connected, events go to the buffer only.** The channel stays
non-blocking.

### 5.1 Command authentication

A localhost server is not private from the user's own browser: any web page open in
another tab can `POST` to `127.0.0.1:8179`. Undefended, an arbitrary site could disable
the microphone — or worse, as commands grow.

Defence, from the start:

- A random token is generated per run and embedded in the served page.
- `/command` requires it in a dedicated header. A cross-origin page cannot read our page
  to obtain it, and a custom header forces a CORS preflight, which the server refuses.
- `GET /events` gets the same origin check. Reading the user's conversation is as much a
  problem as interrupting it.

### 5.2 Shutdown

The server joins `shutdown()` in `cli.ts` alongside the others. The comment already there
— *"Every child must die: a survivor holds the microphone or port 8178"* — applies
verbatim to 8179.

A `--open` flag opens the browser tab at startup. Off by default.

## 6. The panels

### 6.1 Layout

Audio widget fixed at the top, conversation full-width below it, debug as a collapsible
drawer at the bottom.

The drawer was chosen over a permanent side column so that code and rendered artifacts get
the full width. The tradeoff accepted: an error in a closed drawer is less visible. It is
mitigated by surfacing the last event on the drawer's collapsed row, and by `error` events
also reaching the conversation panel.

### 6.2 Audio widget

Status dot (green *in ascolto* / grey *in pausa*), two rows of level bars, three buttons.

- **Green bars — microphone input.** Rise while the user speaks.
- **Blue bars — voice output.** Rise while Axa speaks.

Together they show the whole loop. Paused, the dot greys and the green bars die — the
pause is verifiable at a glance, which is the entire value of a mute.

This also front-runs the dead-microphone failure `device.ts` chases with `DEAD_MIC_MS`:
five seconds of digital silence is reported by the backend, but a flat green bar is
visible immediately.

### 6.3 Conversation panel

A chronological stream with **three visually distinct voices**:

| Voice | Source | Presentation |
|---|---|---|
| **tu** | `heard` | the user's final transcript |
| **axa** | `said` | Claude's answer |
| **sistema** | `aside` | Director lines — greeting, tool narration, apologies. Dimmer: this is scaffolding, not Claude. |

Interleaved in time order: `code` blocks the audio discarded, `tool` activity in compact
form (*⚙ sta cercando sul web*), `approval` requests highlighted with their verdict, and
rendered artifacts at full width.

### 6.4 Debug drawer

Collapsed: one row with the most recent event.

Expanded, in order of importance:

1. **The prompt actually sent**, with `note` rendered separately from `text`.
2. State transitions.
3. Barge-in numbers (`heardMs`, the computed prefix).
4. Tool brackets with detail.
5. Errors.

### 6.5 Panels are independent modules

A panel is one file in `src/panel/public/panels/` declaring an id, a title, and a handler
that receives events and filters what it cares about.

**Adding a panel tomorrow — avatar, file list, history — means adding a file and
registering it, touching neither the server nor the Director.** This is a constraint on
the implementation, not an aspiration.

### 6.6 Affordance

Controls must read as controls: `cursor: pointer`, hover, active and disabled states
(*zitto* is disabled when nothing is being spoken), keyboard-reachable with a visible
focus ring, and immediate visual feedback on click without waiting for the server round
trip.

Spacebar toggles pause when the panel has focus.

This is specified rather than left to taste because a control that does not look like one
is a control the user does not find in the moment they need it — and the moment they need
pause is the moment somebody walked into the room.

## 7. Artifacts and their sandboxing

### 7.1 Two paths in

**Inside the answer.** Claude writes an SVG in a code block. No disk, no permission
prompt, and the content is already in hand via the `code` channel. For a generated chart
this is usually the right path.

**A file on disk.** Claude uses `Write` (requiring a spoken yes) to produce `.svg` or
`.png`. The path arrives **for free**: `canUseTool(toolName, input, opts)` receives
`input`, which carries `file_path`. No accumulation of `input_json_delta` fragments is
needed — a fragile piece of work avoided.

### 7.2 The rules

We are about to render model-produced content in the user's browser, on the same page as
their conversation and prompts.

- **An SVG renders inside an `<img>`, never injected into the document.** SVG can carry
  `<script>`, which executes with full privileges when inlined. Inside an `<img>` the
  browser executes nothing by construction. One line, and the entire class of problem is
  closed without depending on a sanitiser being correct.
- **HTML only inside `<iframe sandbox>`**, without `allow-scripts` and without
  `allow-same-origin`.
- **Never `innerHTML`.** All text, code and transcripts via `textContent`. The transcript
  comes from whisper, which transcribes whoever is in the room: it is untrusted input.
- **`GET /file` is whitelisted:** known extensions only, under the project directory only,
  path resolved and compared **after** resolving symlinks (otherwise `../../` or a symlink
  serves `.env`), with a size ceiling.

### 7.3 The accepted cost

An SVG rendered in an `<img>` **cannot be interactive** — no hover, no scripted animation.
It is a picture. This is a real limitation, accepted knowingly in exchange for not having
to be right about sanitising hostile SVG.

Anything outside the whitelist is not rendered. The panel says *what* it is and *where* it
is, and refuses to open it. A panel that declines to show something is far better than one
that shows it and betrays the user.

## 8. Testing

The suite is `node:test` with fakes for the Director (`tests/director/fakes.ts`). An
event-collecting fake is a few lines, and most of this becomes testable without a browser.

**Director.** That events are emitted at the right moment with the right content —
especially that `prompt` carries `note` separate from `text`, the only way to know the
panel is not lying about what was sent. Command semantics: `pause()` mid-answer lets the
sentence finish; it denies a pending approval; `resume()` returns to listening; **neither
touches the Claude session** — the test that protects "riparte da dove è rimasto".

**Filter.** That a code block reaches the `code` channel **and** stays out of the audio.
Two assertions, not one: the second holds today, the first does not exist yet, and it
would be easy to add one while breaking the other.

**Server.** SSE reconnection via `Last-Event-ID`, and the security tests:

- a `POST` without the token is refused
- a request from a foreign origin is refused
- `../../.env` and a symlink escaping the project are refused
- an extension outside the whitelist is refused

These are regression tests against things somebody will later "simplify". They are what
make §5.1 and §7.2 real rather than good intentions in a comment.

**Not tested automatically:** appearance. Layout, colour and spacing are verified by eye.
To keep that boundary small, panel logic lives in **pure functions** (event → display
text, level → bar height) testable without a DOM; what remains in the browser is appending
elements.

**A live test** behind `AXA_LIVE`, like the four already present: speak, see the panel
update, press pause, watch the orange indicator go out.

## 9. Suggested phasing

This spec covers four subsystems. It is one coherent design, but it should not land as one
commit. A natural order, each step leaving the app working and testable:

1. **The event channel.** Replace `debug` with `onEvent`, define `DirectorEvent`, publish
   from the four existing trace sites. `cli.ts` prints them behind `AXA_DEBUG` as before.
   Nothing visible changes; everything downstream becomes possible.
2. **Commands.** `pause` / `resume` / `stopSpeaking` / `newConversation` on the Director,
   plus the spoken lifecycle lines. Testable and valuable with no UI at all — the greeting
   and the hard stop are worth having before a pixel is drawn.
3. **The server and a minimal panel.** SSE, the ring buffer, the token, the conversation
   panel and the audio widget. This is the step that makes *"guarda lo schermo"* true.
4. **The debug drawer.**
5. **Artifacts**, with the whitelist and sandboxing of §7.

Steps 1 and 2 carry most of the risk of regression in the voice loop, and none of the
browser work. Step 5 carries all of the security surface and none of the voice risk. They
should not be interleaved.

## 10. Open questions

None blocking. The one uncertainty — whether the SDK can clear context cleanly — was
resolved in §4.5 with a verified primary path and a fallback.
