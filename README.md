# axa-voice

Talk to Claude out loud, and interrupt it like you would a person.

A voice front-end for Claude that runs on your machine: you speak, it answers in about a
second, and you can cut it off mid-sentence. It runs on open speakers — no headphones
required — and it never reads code out loud.

> **Status:** design approved, implementation not started.
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
| Time to first sound | ~2s | ~1s |
| Interrupt mid-answer | no | yes, silent within 50ms |
| Knows where it got cut off | — | yes, it resumes from what you actually heard |
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
                                  (Agent     filter      (TTS)       │
                                   SDK)    what to say               ▼
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

## Not a Claude Code plugin (and why)

Claude Code offers no way to inject a user turn into a running interactive session, and
no hook receives streaming tokens. A plugin could therefore speak Claude's answers but
never hear you, and only after the full answer finished. Both halves of the goal are
blocked.

So axa-voice owns the turn loop itself via the Agent SDK. It reads your `~/.claude/`, so
your existing skills, agents and MCP servers work unchanged. A thin plugin exposing
`/voice` to launch it comes later — packaging, not architecture.

Full reasoning and doc citations in [§2 of the design](docs/superpowers/specs/2026-09-11-voice-agent-design.md).

## Roadmap

- **M1 — the loop.** mic → Claude → voice, with echo cancellation and barge-in. Run it
  with `axa-voice`. This either works or the project does not exist.
- **M2 — plugin wrapper.** Installable plugin exposing `/voice`.
- **M3 — avatar.** A 3D head on the monitor, lip-synced from the same audio stream.
- **M4 — holographic display.** Same audio sink, different screen.

On M4: a person floating in mid-air with no screen is not a thing you can buy. What you
can buy is a display that fakes depth convincingly — from a €30 Pepper's ghost sheet of
glass to a Looking Glass or a Proto box. The avatar is just a video, so that choice is
deferred until M3 shows what it has to display.

## Stack

TypeScript · Claude Agent SDK · ElevenLabs (TTS) · Deepgram (STT) ·
macOS VoiceProcessingIO (capture + echo cancellation)

## Docs

- [Design](docs/superpowers/specs/2026-09-11-voice-agent-design.md) — architecture,
  component interfaces, latency budget, testing strategy.
