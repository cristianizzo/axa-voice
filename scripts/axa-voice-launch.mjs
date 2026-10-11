#!/usr/bin/env node
// Launches the axa-voice app (src/cli.ts) detached in the background, with no
// visible window — it is audio-only (mic in, speaker out), so none is needed.
//
// Invoked by the `/axa-voice` plugin command via:
//   node ${CLAUDE_PLUGIN_ROOT}/scripts/axa-voice-launch.mjs
//
// Deliberately plain Node (not TypeScript): it is packaging, not app logic,
// so it stays outside `src/` and outside tsconfig's `include`, the same way
// proto/*.mjs is excluded from the TypeScript build.
//
// Paths are resolved from this file's own location (import.meta.url), never
// from process.cwd(), so this works no matter what directory the user had
// open in Claude Code when they ran /axa-voice — the plugin can be installed
// and invoked from any project.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(repoRoot, 'src', 'cli.ts');
const lockPath = join(tmpdir(), 'axa-voice.lock.json');

/** True if a process with this pid exists (and we can at least see it). */
function isAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    // Signal 0 does not kill anything; it only checks the pid exists.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but is owned by someone else — still alive.
    return err.code === 'EPERM';
  }
}

function readLock() {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

const existing = readLock();
if (existing && isAlive(existing.pid)) {
  console.log(`ALREADY_RUNNING pid=${existing.pid} startedAt=${existing.startedAt ?? 'unknown'}`);
  process.exit(0);
}

if (existing) {
  // Stale lock from a process that is no longer running — clear it so this
  // launch isn't mistaken for a second one later.
  try {
    unlinkSync(lockPath);
  } catch {
    // Not fatal: we are about to overwrite it anyway.
  }
}

const child = spawn(process.execPath, [cliPath], {
  cwd: repoRoot,
  detached: true,
  stdio: 'ignore',
  env: process.env,
});

// Detach fully: a parent exit must not take the child down with it, and we
// must not hold this script's event loop open waiting on the child.
child.unref();

// Wait for whichever of 'spawn'/'error' fires first before reporting, so a
// synchronous "STARTED" can't race ahead of an async ENOENT from a bad path.
child.once('spawn', () => {
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }),
  );
  console.log(`STARTED pid=${child.pid}`);
});

child.once('error', (err) => {
  console.log(`ERROR failed to spawn axa-voice: ${err.message}`);
  process.exitCode = 1;
});
