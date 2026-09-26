import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface Config {
  readonly audio: {
    deviceRate: number; frameRate: number; frameSamples: number; helperPath: string;
  };
  readonly stt: {
    port: number; modelPath: string; vadModelPath: string;
    partialCadenceMs: number; partialAudioCtx: number; language: string;
  };
  readonly turn: { silenceMs: number; unfinishedSilenceMs: number; stablePrefixDropTokens: number };
  readonly voice: { model: string; voiceId: string; apiVersion: string; language: string };
  readonly director: {
    approvalTimeoutMs: number;
    turnTimeoutMs: number;
    interruptTimeoutMs: number;
  };
  readonly readOnlyTools: readonly string[];
  /** The screen-control toggle script, run directly by the Director (spec: gui-command.ts). */
  readonly gui: { scriptPath: string };
  /** Non-enumerable on purpose: keeps the secret out of logs and crash dumps. */
  cartesiaKey(): string;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const key = env.CARTESIA_API_KEY?.trim();
  if (!key) {
    throw new Error(
      'CARTESIA_API_KEY is missing. Copy .env.example to .env and fill it in. ' +
        'Failing now rather than at first speech (spec §9).',
    );
  }

  const config = {
    audio: {
      deviceRate: 24000,
      frameRate: 16000,
      frameSamples: 320,
      helperPath: join(root, 'native', 'aecio'),
    },
    stt: {
      port: 8178,
      // large-v3-turbo over small: regional Italian accents need the acoustic
      // model's training breadth, not just better decoding — beam-size/best-of
      // (server.ts) only fixes how a heard word gets decoded, not whether it
      // was heard right in the first place. turbo keeps most of large-v3's
      // accuracy while staying close to real-time on Metal, unlike full large-v3.
      modelPath: join(root, 'models', 'ggml-large-v3-turbo.bin'),
      vadModelPath: join(root, 'models', 'ggml-silero-v5.1.2.bin'),
      partialCadenceMs: 350,
      partialAudioCtx: 1000,
      // Explicit, not 'auto': most turns here are 1-2s, too short for reliable
      // language detection — a wrong guess makes the transcription worse, not
      // more flexible. Forcing the known language skips that gamble.
      language: 'it',
    },
    turn: { silenceMs: 250, unfinishedSilenceMs: 700, stablePrefixDropTokens: 2 },
    voice: {
      model: 'sonic-3',
      voiceId: 'c8403b5c-6465-4396-9065-a440d376528a',
      apiVersion: '2026-08-14',
      language: 'it',
    },
    director: {
      approvalTimeoutMs: 10000,
      // A hard ceiling on a single turn (spec: 2026-09-26, "sto cercando" then
      // silence forever). The progress narration covers a slow tool for as
      // long as it actually runs, but nothing previously covered a turn whose
      // stream never produces another event at all — a genuinely hung network
      // call inside the agent's tool left the Director listening for an event
      // that would never come. Generous on purpose: a real multi-search
      // answer can legitimately take tens of seconds; this is a backstop for
      // "never", not a budget for "slow".
      turnTimeoutMs: 45_000,
      // A bound on agent.interrupt() itself (spec: 2026-09-26, a barge-in that
      // froze the whole app because a background subagent Task was still
      // running and interrupt() never returned). Both a barge-in and a
      // redispatch after "unclear" await this directly, outside #run, so
      // turnTimeoutMs does not cover it — this is the one that does. Short: a
      // slow interrupt should cost the user a beat, not the rest of the turn.
      interruptTimeoutMs: 3000,
    },
    readOnlyTools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'ToolSearch'] as const,
    gui: { scriptPath: join(homedir(), '.claude', 'bin', 'gui') },
  };

  Object.defineProperty(config, 'cartesiaKey', {
    value: () => key,
    enumerable: false,
  });

  // TypeScript cannot see a property added by defineProperty, and that is the
  // whole point of adding it that way: invisible to enumeration means invisible
  // to JSON.stringify and to console.log.
  return config as unknown as Config;
}
