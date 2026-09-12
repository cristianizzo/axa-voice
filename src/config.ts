import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
  readonly director: { fillerAfterMs: number; approvalTimeoutMs: number };
  readonly readOnlyTools: readonly string[];
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
      modelPath: join(root, 'models', 'ggml-small.bin'),
      vadModelPath: join(root, 'models', 'ggml-silero-v5.1.2.bin'),
      partialCadenceMs: 350,
      partialAudioCtx: 1000,
      language: 'it',
    },
    turn: { silenceMs: 250, unfinishedSilenceMs: 700, stablePrefixDropTokens: 2 },
    voice: {
      model: 'sonic-3',
      voiceId: 'c8403b5c-6465-4396-9065-a440d376528a',
      apiVersion: '2026-08-14',
      language: 'it',
    },
    director: { fillerAfterMs: 1200, approvalTimeoutMs: 10000 },
    readOnlyTools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'ToolSearch'] as const,
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
