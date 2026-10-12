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
      // The conversation's STARTING language, not a permanent lock (spec:
      // 2026-09-27, mid-conversation language switch). Every PARTIAL request
      // still pins this exact language explicitly, not 'auto': partials run
      // every partialCadenceMs and a wrong guess there is pure noise, not
      // flexibility — the same "too short to trust" concern this comment used
      // to describe for every turn still holds for a 350ms-cadence partial.
      // Only the FINAL request now asks whisper-server to auto-detect
      // (transcriber.ts's `#transcribe`), and even then Director's sticky-
      // language policy (`#maybeSwitchLanguage`, MIN_WORDS_FOR_LANGUAGE_SWITCH
      // / MIN_LANGUAGE_CONFIDENCE) only acts on that guess once a whole final
      // utterance is long and confident enough to trust — the original
      // 1-2s-utterance concern didn't go away, it moved from "never detect"
      // to "detect, but gate hard before acting on it".
      language: 'it',
    },
    turn: { silenceMs: 250, unfinishedSilenceMs: 700, stablePrefixDropTokens: 2 },
    voice: {
      model: 'sonic-3',
      voiceId: 'c8403b5c-6465-4396-9065-a440d376528a',
      apiVersion: '2026-08-14',
      // Same starting-not-permanent language as stt.language above — Director
      // overrides this per call on `voice.synthesize()` once the sticky-
      // language policy decides the conversation has actually switched.
      language: 'it',
    },
    director: {
      // Must legitimately outlast the round trip it is timing (spec:
      // 2026-09-27, a spoken full-sentence reply was abandoned as GAVE_UP
      // because the clock ran out before the answer was ever transcribed).
      // The clock starts in #onPermission BEFORE the question is even spoken
      // — #say("Posso ...?") is fired-and-forgotten, not awaited, so arming
      // happens first — so it has to cover, in sequence: #say() actually
      // speaking the question out loud (several seconds for a real tool
      // summary, not an instant), the user's reaction time, the time to SAY
      // a reply, the VAD's trailing-silence requirement before it calls turn
      // end (turn.unfinishedSilenceMs, up to 700ms), and only then whisper's
      // final transcription (src/stt/transcriber.ts REQUEST_TIMEOUT_MS =
      // 15000ms — itself a *single* generous attempt, not a probe). 15000ms
      // alone already exceeded the old 10000ms budget, so any reply that made
      // whisper work for its money was doomed before the user finished
      // speaking, regardless of what they said.
      //
      // Note what this constant does NOT fix: a full sentence like "sì,
      // cerca web3 developer" is 5 normalised words, which
      // src/director/approval.ts's MAX_WORDS = 4 classifies as 'unclear'
      // (a new turn, not consent) independent of timing — raising this
      // timeout only changes that case's failure mode from a silent
      // GAVE_UP-timeout to an audible deny-and-redispatch, which is
      // approval.ts's whole-utterance design working as intended, not
      // something this number changes.
      //
      // Also note this timer no longer competes with turnTimeoutMs for the
      // same budget: director.ts stops the turn timer for the duration of
      // the approval wait (#onPermission) and re-arms it once #answer()
      // resumes the turn, so a slow answerer no longer eats into the tool's
      // own execution window below.
      approvalTimeoutMs: 20000,
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
