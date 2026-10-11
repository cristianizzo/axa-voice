# axa-voice

Talk to Claude out loud, and interrupt it like you would a person.

A voice front-end for Claude that runs on your machine: you speak, it answers in about a
second, and you can cut it off mid-sentence. It runs on open speakers — no headphones
required — and it never reads code out loud.

> **Status:** M1 implemented — `npm start` runs the real loop.
> See [the design doc](docs/superpowers/specs/2026-09-11-voice-agent-design.md).

## Why

Siri feels like a robot for three reasons, and none of them is voice quality:

- It takes ~2 seconds to start answering.
- You cannot interrupt it.
- It says the wrong things — a coding assistant that reads file paths letter by letter
  is unusable within thirty seconds.

axa-voice targets exactly those three:

| | Siri | axa-voice |
|---|---|---|
| Time to first sound | ~2s | ~1.3s (measured, not estimated) |
| Interrupt mid-answer | no | yes, silent within 50ms |
| Knows where it got cut off | — | yes, it resumes from what you actually heard |
| Talk while it is working | — | adds to the conversation instead of cancelling it; answered next |
| During a long search | silence | says what it is doing, every few seconds |
| Reads code aloud | — | never; code stays on screen |

## How it works

```
   mic ──▶ capture ──▶ turn ──▶ transcribe ──┐
            (echo        detect               │
           cancelled)                         ▼
                                      ┌──────────────┐
                                      │   DIRECTOR   │
                                      └──────────────┘
                                         │        │
                                         ▼        ▼
                                  Claude ──▶ speech ──▶ voice ──▶ speakers
                                  (one       filter      (TTS)       │
                                  session) what to say               ▼
                                                              avatar (later)
```

Eight components. Seven are deliberately simple; the Director holds all the logic.
Speech-to-text and text-to-speech sit behind interfaces, so switching provider — or
moving fully local for cost or privacy — is a config change, not a rewrite.

Two design points do most of the work:

- **Nothing waits for a complete answer.** The first finished sentence goes to the voice
  while Claude is still writing the rest.
- **Echo cancellation from day one.** Otherwise the microphone hears the speakers, the
  agent transcribes itself, and interrupts itself in a loop.

## Permissions, out loud

A voice session has nowhere to show a permission dialog, so the prototype simply hung
when Claude asked for one. The fix is to decide in advance, by category:

- **Reading is always allowed** — files, search, the web. Worst case is wasted time, and
  you are sitting right there listening.
- **Writing and running commands ask you out loud** — *"vuoi che scriva su session.ts?"*
  — and wait for a spoken yes.
- **Anything it doesn't clearly hear as a yes counts as a no.** Speech recognition
  invents words during silence; a misheard *no* costs one repeated sentence, a misheard
  *yes* edits your files.
- **No approval is ever remembered.** You cannot see what you would be agreeing to for
  the rest of the session.

## Not a Claude Code plugin (and why)

Claude Code offers no way to inject a user turn into a running interactive session, and
no hook receives streaming tokens. A plugin could therefore speak Claude's answers but
never hear you, and only after the full answer finished. Both halves of the goal are
blocked.

So axa-voice owns the turn loop itself, driving one long-lived Claude session. It reads
your `~/.claude/`, so your existing skills, agents and MCP servers work unchanged —
though MCP servers are loaded on demand, because connecting them all up front costs
5–7 seconds on every turn. A thin plugin exposing `/axa-voice` to launch it is described
below — packaging, not architecture.

Full reasoning and doc citations in [§2 of the design](docs/superpowers/specs/2026-09-11-voice-agent-design.md).

## Install as a Claude Code plugin

M2 packages the standalone app above as a plugin whose only job is launching it. The
plugin does not replace the turn loop or talk to Claude Code's own session — it just
starts `node src/cli.ts` as a detached background process (no window, since this is
audio-only: mic in, speaker out) and gets out of the way.

Add this checkout as a plugin (from within Claude Code):

```
/plugin marketplace add /absolute/path/to/axa-voice
/plugin install axa-voice
```

or point Claude Code at the git remote instead of a local path, if installing on another
machine. Then, from any project, in any working directory:

```
/axa-voice
```

This starts axa-voice in the background and replies with a one-line confirmation. Running
`/axa-voice` again while it's already running reports that instead of starting a second
instance — two instances would fight over the same microphone and speaker. There is no
`/axa-voice stop`; kill the reported PID, or `pkill -f src/cli.ts`.

## Roadmap

- **M1 — the loop.** mic → Claude → voice, with echo cancellation and barge-in. Run it
  with `axa-voice`. This either works or the project does not exist.
- **M2 — plugin wrapper.** Installable plugin exposing `/axa-voice`.
- **M3 — avatar.** A 3D head on the monitor, lip-synced from the same audio stream.
- **M4 — holographic display.** Same audio sink, different screen.

On M4: a person floating in mid-air with no screen is not a thing you can buy. What you
can buy is a display that fakes depth convincingly — from a €30 Pepper's ghost sheet of
glass to a Looking Glass or a Proto box. The avatar is just a video, so that choice is
deferred until M3 shows what it has to display.

## Stack

TypeScript · Claude CLI in streaming mode · Cartesia Sonic-3 (TTS) ·
local whisper.cpp (STT) · macOS VoiceProcessingIO (capture + echo cancellation)

Both the TTS and the STT sit behind one-method interfaces. ElevenLabs and Deepgram are
drop-in alternatives.

## Run it

macOS and Node 22.18+ (the source is TypeScript and runs unbuilt, via Node's type
stripping).

**1. whisper.cpp on your PATH.** `whisper-server` 1.9.2 or newer — earlier versions have
no `--vad`, and without VAD whisper turns silence into confident sentences.

```sh
brew install whisper-cpp
```

**2. Two models.** They are large and not in git, so this step is not optional.

```sh
mkdir -p models
curl -L -o models/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
curl -L -o models/ggml-silero-v5.1.2.bin \
  https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin
```

**3. The audio helper.** A small Swift binary around macOS VoiceProcessingIO — it is what
stops the microphone from hearing the speakers. Needs the Xcode command-line tools.

```sh
npm install
npm run build:native
```

**4. Your Cartesia key.**

```sh
cp .env.example .env      # add CARTESIA_API_KEY
```

Then:

```sh
npm start
```

The first run asks for microphone access. Say something; it answers out loud. Cut it off
mid-sentence and it stops within 50ms and picks up from what you actually heard. Ask it to
write a file and it asks you out loud first — anything it does not clearly hear as a yes
counts as a no.

## Tests

```sh
npm test            # 165 unit tests, no hardware, no network, no money
npm run typecheck
```

Four tests are skipped by default because they touch the real world:

```sh
AXA_LIVE=1 npm test   # real Claude session, real Cartesia, real speakers
```

- `tests/integration/latency.test.ts` measures end-to-end time to first audio and fails
  above 1300ms. It discards turn 1: that one pays process spawn and system-prompt
  processing, measures ~7s, and reporting it would send someone optimising something that
  was never slow.
- `tests/integration/echo.test.ts` plays 3s of speech out of the speakers with the
  microphone open and asserts the transcript is empty. **Do not run it with headphones on**
  — headphones hide exactly the bug it exists to catch.
- `tests/audio/helper.test.ts` drives the native helper: it opens the real microphone,
  so it asks first rather than doing it behind a plain `npm test`.

`AXA_DEBUG=1 npm start` prints the turn trace.

## Docs

- [Design](docs/superpowers/specs/2026-09-11-voice-agent-design.md) — architecture,
  component interfaces, measured latency budget, permission model, testing strategy.
