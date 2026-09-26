import { access, constants } from 'node:fs/promises';
import { emitKeypressEvents } from 'node:readline';
import { loadConfig } from './config.ts';
import { AudioDevice } from './audio/device.ts';
import { WhisperServer } from './stt/server.ts';
import { WhisperTranscriber } from './stt/transcriber.ts';
import { VadTurnDetector } from './turn/detector.ts';
import { ClaudeAgentSession } from './agent/session.ts';
import { CartesiaVoice } from './voice/cartesia.ts';
import { SentenceSpeechFilter } from './filter/speech-filter.ts';
import { Director } from './director/director.ts';
import { runGuiCommand } from './system/gui.ts';

const envFile = new URL('../.env', import.meta.url);
try {
  process.loadEnvFile(envFile);
} catch {
  // Not an error: the key may come from the shell. loadConfig is what decides
  // whether we have what we need, and it says so in one clear sentence.
}

const config = loadConfig(process.env);

/**
 * The helper is built, not shipped. Spawning it produces "spawn ENOENT", which
 * is true and useless; this says what to run instead (spec §9).
 */
async function checkHelper(): Promise<void> {
  await access(config.audio.helperPath, constants.X_OK).catch(() => {
    throw new Error(
      `the audio helper is missing or not executable at ${config.audio.helperPath}.\n` +
        'Build it with: npm run build:native',
    );
  });
}

const whisper = new WhisperServer(config);
const device = new AudioDevice(config);
const agent = new ClaudeAgentSession(config);
const voice = new CartesiaVoice(config);

const director = new Director({
  config,
  audioIn: device,
  audioOut: device,
  // Dumps the exact audio sent for each turn's final transcription, so a live
  // mistranscription can be replayed offline instead of guessed at (spec: the
  // 2026-09-23 garbled-English report, which an isolated fixture test could
  // not reproduce).
  transcriber: new WhisperTranscriber(config, {
    dumpDir: process.env.AXA_DEBUG ? new URL('../debug-audio/', import.meta.url).pathname : undefined,
  }),
  turns: new VadTurnDetector(config),
  agent,
  voice,
  filter: new SentenceSpeechFilter(),
  runGui: (mode) => runGuiCommand(config.gui.scriptPath, mode),
  onError: (message) => console.error(`\n[audio] ${message}`),
  // Off by default: the failure this exists to diagnose was a silent process,
  // not a noisy one. Set AXA_DEBUG=1 to get the per-turn trace back.
  debug: process.env.AXA_DEBUG ? console.error : undefined,
});

let shuttingDown = false;
async function shutdown(code = 0): Promise<never> {
  // A second Ctrl-C means the user is done waiting for a graceful exit.
  if (shuttingDown) process.exit(code);
  shuttingDown = true;
  // Every child must die: a survivor holds the microphone or port 8178, and the
  // next run fails with an error that points nowhere near the real cause.
  await Promise.allSettled([director.stop(), agent.close(), device.stop(), whisper.stop()]);
  process.exit(code);
}
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
// Node's default for both is to print and exit immediately, which skips the
// shutdown above and leaves exactly the orphans it exists to prevent: a stray
// helper holding the microphone, a whisper-server holding port 8178.
process.on('uncaughtException', (error) => {
  console.error(`\nerrore non gestito: ${error.stack ?? error.message}\n`);
  void shutdown(1);
});
process.on('unhandledRejection', (reason) => {
  console.error(`\npromise rifiutata e non gestita: ${String(reason)}\n`);
  void shutdown(1);
});

try {
  await checkHelper();
  console.log('avvio whisper…');
  await whisper.start();
  console.log('scaldo la sessione…');
  await agent.start(); // ~900ms, must not land on the first turn (spec §4)
  console.log('apro il microfono…');
  await director.start();
  console.log('pronto. parla pure.  (ctrl-c per uscire, barra spaziatrice per silenziare)');

  // Manual mic mute: a background tool call can run long enough that a nearby
  // conversation not meant for Axa gets treated as a follow-up, and the mic
  // itself is the only thing that can reliably say "not talking to you" while
  // the agent is busy. Keypress, not a spoken command, on purpose — it must
  // not depend on the very channel it is meant to silence.
  if (process.stdin.isTTY) {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    // Raw mode stops the terminal from turning Ctrl-C into SIGINT itself, so
    // the existing shutdown path has to be re-armed here or the app becomes
    // unkillable the moment muting is available.
    process.stdin.on('keypress', (_str, key: { name?: string; ctrl?: boolean } | undefined) => {
      if (key?.ctrl && key.name === 'c') {
        void shutdown(0);
        return;
      }
      if (key?.name === 'space') director.setMuted(!director.muted);
    });
  }
} catch (error) {
  console.error(`\nnon riesco a partire: ${(error as Error).message}\n`);
  await shutdown(1);
}
