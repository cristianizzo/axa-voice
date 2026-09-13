# Interruption and waiting model — design

**Status:** approved, not implemented.
**Amends:** [§6 of the M1 design](2026-09-11-voice-agent-design.md) (barge-in), and adds
a waiting model that spec did not have.

## The problem, as measured

A real session on 2026-09-12, recovered from the agent transcript:

```
USER:      Voglio sapere quando gioca il Napoli
ASSISTANT: Aspetta, controllo subito.  <tool_use:WebSearch>
USER:      [Request interrupted by user for tool use]
USER:      [L'utente ti ha interrotto. Ha sentito solo: ""] Ha detto: Allora
```

Three separate defects, in one exchange:

1. **Silence for minutes during a tool call.** Nothing covers a running tool:
   `WebSearch` runs after the first sentence, covered by nothing. (The filler, since
   removed, only ever covered the wait for the first token.)
2. **The user's prompt killed the work.** Hearing silence, the user said *"Allora"*. That
   was treated as barge-in and cancelled the search — the one thing being waited for.
   This repeated: the second attempt was cancelled the same way.
3. **The interruption note claimed nothing was heard.** `Ha sentito solo: ""` while the
   user had plainly heard *"Aspetta, controllo subito."*

Defect 2 is not a missing feature. It is a **divergence from the existing spec**: §6 line
411 scopes barge-in to `SPEAKING`, while `director.ts:211` reads

```js
const wasAnswering = this.#state === 'THINKING' || this.#state === 'SPEAKING';
```

`THINKING` was added by the implementation and never specified.

## Goal

Behave like a person on a phone call: you can cut it off while it is *talking*, but
talking *at* it while it is working adds to the conversation instead of destroying it.

Out of scope, deliberately: delegating long work to a background agent so the
conversation continues *during* the search. That is a feature, not a fix, and it needs
its own spec — results must re-enter as fresh turns, with an ordering story for the case
where the user changed subject meanwhile.

## 1. Barge-in applies only while speaking

`#onSpeechStart` treats only `SPEAKING` as interruptible. The mechanism itself — flush,
abort the TTS, `interrupt()`, map `heardMs` back to text — is unchanged.

This exposes a structural problem. `#state` currently answers two questions at once:
*what is the agent doing* and *am I capturing the user*. Those must now both be true at
the same time. Rather than add a hybrid state, move the decision:

- `#onFrame` feeds whisper whenever the turn detector reports speech, whatever the state.
- `#onTurnEnd` routes the resulting transcript by state.

`THINKING` stays `THINKING` while the user is being recorded. The state machine keeps
four states and gains no fifth.

Routing in `#onTurnEnd`:

| State | Transcript becomes |
|---|---|
| `HEARING` | a normal turn (unchanged) |
| `AWAITING_APPROVAL` | an approval answer (unchanged) |
| `THINKING` | a stop command if it is one, otherwise queued (§2, §3) |

`SPEAKING` is absent from the table on purpose: speech during `SPEAKING` already triggers
barge-in in `#onSpeechStart`, which moves the state to `HEARING` before any transcript
exists. By the time `#onTurnEnd` runs, that path is the `HEARING` row.

## 2. What you say while it works is queued, not dropped

A `#queued: string[]`. When a turn's answer completes, a queued utterance starts the next
turn as if freshly spoken.

Everything queued passes `clean()` first — the existing hallucination filter. Whisper
invents confident sentences out of silence, and a cough must not become a question the
user then has to sit through an answer to.

## 3. Stopping it on purpose

`isStopCommand(text)` joins `interpretApproval` in `src/director/approval.ts`, reusing the
private `normalise`. Same file because it is the same responsibility — reading a short
spoken command — and putting it elsewhere would mean exporting internals that exist to
stay private.

It inherits the discipline that module already enforces: whole-utterance match, never a
substring, with the word-count ceiling as defence in depth. *"Non dirmi basta"* must not
stop anything.

**The stop set is not the `NO` set, and must not be merged with it.** `NO` contains
`aspetta` (line 21), correct for a permission answer and wrong here: while it is working,
*"aspetta"* usually means *"hold on, I'm adding something"* — the opposite of stop. The
two sets overlap; they are not the same set.

Stop vocabulary: `basta`, `stop`, `lascia stare`, `lascia perdere`, `annulla`,
`annullalo`, `ferma`, `fermati`, `fermo`. Explicitly excluded: `aspetta`.

A stop command cancels the turn via `interrupt()` and returns to `LISTENING` without
queueing anything.

## 4. Saying what it is doing

The Director never sees raw agent events: `filter.filter(agent.send(text))` consumes the
whole stream and yields only sentences. `AgentEvent` has carried
`{ type: 'tool'; name; phase: 'start' | 'end' }` (`src/types.ts:69`) since M1 with no
consumer — `director.ts` contains zero occurrences of the word.

Interpose a pass-through generator that observes events and forwards them unchanged to
the filter.

On `phase: 'start'`, speak a line every **3 s** drawn from a tool-to-Italian map —
`WebSearch` → *"sto cercando sul web"*, `Read` → *"sto leggendo"* — never repeating the
previous line. On `phase: 'end'`, or on the first sentence of the real answer, stop.

§7 still governs: name the **action**, never the path or the arguments. A progress line
is Director speech the user did not ask for, and is subject to the same rule.

These lines must not enter `#spoken` or move `#answerFromMs`. They are not part of the
answer, and counting them would corrupt the interruption note — which is defect 3.

## 5. The empty heard-prefix

**Hypothesis, not a diagnosis.** It is written down as a hypothesis on purpose: the
correction is cheap enough to be tempting to apply unverified.

`#enqueuedMs` counts every millisecond handed to the device. `flush()` *discards*
whatever has not been rendered yet, and those milliseconds were already counted. So
`#enqueuedMs` runs permanently ahead of what the device reports as heard, and the gap
widens at every barge-in until `heardMs - #answerFromMs` goes negative and `#heardPrefix`
returns `''` for everything.

If confirmed, the fix is one line: set `#enqueuedMs = heardMs` after each flush. Once
audio has been dropped, what the device rendered *is* everything that ever reached the
speakers, so the two timelines re-synchronise at exactly the moment they would otherwise
diverge.

**Verify before fixing.** Add a per-turn diagnostic behind `AXA_DEBUG=1` — transcript,
state transitions, tool names, and `#enqueuedMs` / `#answerFromMs` / `heardMs` /
resulting prefix — then reproduce with two consecutive barge-ins and read the numbers.

The absence of any per-turn output is itself a defect this addresses: during the failure
above, the only diagnosis the operator could offer was "it isn't working well", because
the process printed nothing between startup and shutdown.

## 6. Testing

Unit, against the existing Director fakes:

- barge-in fires while `SPEAKING`; it does **not** fire while `THINKING`
- an utterance during `THINKING` is queued and answered after the current answer
- a bare stop command during `THINKING` cancels the turn
- the same word inside a longer sentence does **not** cancel
- a hallucinated transcript during `THINKING` is never queued
- `aspetta` does not stop, and still reads as `no` for an approval
- `tool` start begins the progress lines; `tool` end stops them
- progress lines change `#spoken` and `#answerFromMs` not at all

Regression for defect 3, and the reason it is listed separately: **two consecutive
barge-ins must both produce a correct prefix.** The first one passing proves nothing —
the timelines only diverge once audio has been dropped.

Live, on hardware: the exchange at the top of this document, replayed. It must reach an
answer without the search being cancelled.
