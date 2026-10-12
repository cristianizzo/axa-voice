#!/usr/bin/env node
// Launches the axa-voice app (src/cli.ts) detached in the background, with no
// visible window — it is audio-only (mic in, speaker out), so none is needed.
//
// Invoked by the `/axa-voice:start` plugin command via:
//   node "${CLAUDE_PLUGIN_ROOT}/scripts/axa-voice-launch.mjs"
//
// Deliberately plain Node (not TypeScript): it is packaging, not app logic,
// so it stays outside `src/` and outside tsconfig's `include`, the same way
// proto/*.mjs is excluded from the TypeScript build.
//
// Paths are resolved from this file's own location (import.meta.url), never
// from process.cwd(), so this works no matter what directory the user had
// open in Claude Code when they ran /axa-voice:start — the plugin can be
// installed and invoked from any project.

import { spawn } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
  openSync,
  closeSync,
  readSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(repoRoot, 'src', 'cli.ts');
const lockPath = join(tmpdir(), 'axa-voice.lock.json');

// How long to watch the child's own output for an early crash before
// reporting STARTED and detaching for good. Long enough to catch a missing
// `.env`, missing models, or a missing native helper failing fast; short
// enough that the command still replies promptly for the common case where
// axa-voice starts fine and keeps running well past this window.
const STARTUP_GRACE_MS = 2500;
const MAX_LOCK_CLAIM_ATTEMPTS = 5;

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

/**
 * Writes `data` to the lock file via write-temp-then-rename, so the lock
 * file itself is never observed half-written, and a rename over an existing
 * lock replaces it atomically (POSIX rename is an atomic directory-entry
 * swap) rather than leaving a window where the lock file briefly doesn't
 * exist, as a plain unlink-then-write would.
 */
function writeLockAtomic(data) {
  const tmpPath = `${lockPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(data));
  renameSync(tmpPath, lockPath);
}

/**
 * Reserves the lock file for this process *before* anything is spawned, so
 * two concurrent invocations can't both observe "no lock" and both go on to
 * spawn a child — only one of them can win the exclusive create below.
 *
 * Returns the reservation record this process wrote, once it is confirmed
 * to be the one actually on disk.
 */
function claimLock() {
  for (let attempt = 0; attempt < MAX_LOCK_CLAIM_ATTEMPTS; attempt++) {
    const reservation = { pid: process.pid, startedAt: new Date().toISOString() };

    try {
      // Exclusive create: fails with EEXIST if a lock is already there.
      // This is the atomic step — there is no gap between "check" and
      // "claim" for the common case of no existing lock.
      writeFileSync(lockPath, JSON.stringify(reservation), { flag: 'wx' });
      return reservation;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }

    const existing = readLock();
    if (existing && isAlive(existing.pid)) {
      console.log(`ALREADY_RUNNING pid=${existing.pid} startedAt=${existing.startedAt ?? 'unknown'}`);
      process.exit(0);
    }

    // Stale lock from a process that is no longer running. Replace it
    // atomically (not unlink-then-later-write) and then verify this
    // process actually won the replace before trusting it — a concurrent
    // launch could be doing the exact same stale-lock takeover right now.
    try {
      writeLockAtomic(reservation);
    } catch {
      // Lost a race to create the temp file or to rename; retry the loop.
      continue;
    }

    const verify = readLock();
    if (verify && verify.pid === reservation.pid && verify.startedAt === reservation.startedAt) {
      return reservation;
    }
    // Someone else's reservation landed on top of ours — loop and re-check.
  }

  throw new Error('could not claim axa-voice.lock.json after retries');
}

function releaseLockIfOwnedByUs() {
  const existing = readLock();
  if (existing && existing.pid === process.pid) {
    try {
      unlinkSync(lockPath);
    } catch {
      // Not fatal.
    }
  }
}

claimLock();

// Child output is captured to a small temp log file (not piped to this
// process) for a bounded grace window, so an early crash can be reported
// instead of silently returning STARTED. A log file has no backpressure —
// unlike a pipe, nothing needs to keep draining it once we stop reading, so
// the detached child is never at risk of blocking on a full pipe buffer
// after this launcher exits.
const logPath = join(tmpdir(), `axa-voice-launch-${process.pid}.log`);
const logFd = openSync(logPath, 'a');

const child = spawn(process.execPath, [cliPath], {
  cwd: repoRoot,
  detached: true,
  stdio: ['ignore', logFd, logFd],
  env: process.env,
});

// Detach fully: a parent exit must not take the child down with it, and we
// must not hold this script's event loop open past the grace window below.
child.unref();

function readLogTail(maxBytes = 4096) {
  try {
    const fd = openSync(logPath, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
      return buf.toString('utf8', 0, bytesRead).trim();
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

function cleanupLogFile() {
  try {
    closeSync(logFd);
  } catch {
    // Already closed or in use by the child — not fatal.
  }
  try {
    unlinkSync(logPath);
  } catch {
    // Not fatal.
  }
}

let settled = false;

function reportStarted() {
  if (settled) return;
  settled = true;
  writeLockAtomic({ pid: child.pid, startedAt: new Date().toISOString() });
  try {
    closeSync(logFd);
  } catch {
    // Already closed — not fatal.
  }
  console.log(`STARTED pid=${child.pid}`);
}

function reportEarlyExit(code, signal) {
  if (settled) return;
  settled = true;
  clearTimeout(graceTimer);
  const output = readLogTail();
  cleanupLogFile();
  releaseLockIfOwnedByUs();
  const reason = signal ? `signal ${signal}` : `code ${code}`;
  const detail = output ? `: ${output}` : ' (no output captured)';
  console.log(`ERROR axa-voice exited immediately (${reason})${detail}`);
  process.exitCode = 1;
}

function reportSpawnError(err) {
  if (settled) return;
  settled = true;
  clearTimeout(graceTimer);
  cleanupLogFile();
  releaseLockIfOwnedByUs();
  console.log(`ERROR failed to spawn axa-voice: ${err.message}`);
  process.exitCode = 1;
}

child.once('error', reportSpawnError);
child.once('exit', reportEarlyExit);

const graceTimer = setTimeout(() => {
  child.off('exit', reportEarlyExit);
  reportStarted();
}, STARTUP_GRACE_MS);
