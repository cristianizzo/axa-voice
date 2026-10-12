---
description: Launch the axa-voice assistant (mic in, speaker out) as a background process
allowed-tools: Bash(node:*)
---

Launch result: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/axa-voice-launch.mjs"`

Tell the user, in one short sentence, what happened — based only on the "Launch result" line
above. Do not print that raw line verbatim; paraphrase it. This is a one-shot message: once
axa-voice is running it is a detached background process with no terminal window (it is
audio-only), so there is nothing further this command can report.

- Output starts with `STARTED pid=<pid>`: tell the user axa-voice just started in the
  background and to say something to begin. Mention the PID only if they ask. To stop it later,
  they can kill that PID or run `pkill -f src/cli.ts` from a terminal — there is no
  `/axa-voice:stop` command.
- Output starts with `ALREADY_RUNNING pid=<pid> startedAt=<time>`: tell the user it is already
  running (include the start time) and that this did not start a second instance — a second
  instance would fight the first for the same microphone and speaker.
- Output starts with `ERROR ...`: relay the error message plainly (e.g. a missing native audio
  helper, or a missing `.env`) so the user knows what to fix. Do not try to fix it yourself —
  `README.md` → "Run it" has the setup steps.
