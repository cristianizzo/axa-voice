import type { AudioFrame, TurnDetector, Unsubscribe } from '../types.ts';
import type { Config } from '../config.ts';

/**
 * Energy hysteresis. Starting a turn takes real level; keeping one alive does
 * not. Measured on conversational Italian, the frames between words sit at
 * 200–500 RMS, so a single threshold either misses onsets or reports silence in
 * the middle of a sentence.
 */
const SPEECH_ONSET_RMS = 500;
const SPEECH_CONTINUE_RMS = 200;

/** Italian words that cannot end an utterance. */
const TRAILING_CONJUNCTIONS = new Set([
  'e', 'ed', 'o', 'oppure', 'ma', 'però', 'che', 'se', 'quando', 'mentre',
  'perché', 'con', 'di', 'da', 'per', 'in', 'su', 'tra', 'fra', 'il', 'la',
  'lo', 'un', 'una', 'del', 'della',
]);

/**
 * Whisper truncates or invents the last word of a growing buffer, so the tail of
 * a partial churns on every pass. Comparing whole strings therefore never
 * converges and the turn never ends (spec §5).
 */
export function stablePrefix(text: string, dropTokens: number): string {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length <= dropTokens) return '';
  return tokens.slice(0, tokens.length - dropTokens).join(' ');
}

export function looksUnfinished(text: string): boolean {
  const trimmed = text.trim();
  // No transcript is the most unfinished state there is: the first partial only
  // lands ~800ms into an utterance, so before it arrives there is no evidence
  // that the user has finished anything.
  if (!trimmed) return true;
  const tokens = trimmed.toLowerCase().replace(/[.,;:!?…]+$/, '').split(/\s+/);
  const last = tokens.at(-1);
  return last !== undefined && TRAILING_CONJUNCTIONS.has(last);
}

function rms(frame: AudioFrame): number {
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
  return Math.sqrt(sum / Math.max(1, frame.length));
}

export class VadTurnDetector implements TurnDetector {
  readonly #config: Config;
  readonly #now: () => number;
  readonly #startHandlers = new Set<() => void>();
  readonly #endHandlers = new Set<() => void>();

  #speaking = false;
  /**
   * Silence is measured from the last frame that CONTAINED speech, not from the
   * first silent frame. Starting the clock one frame late loses a whole 20ms
   * frame off every endpoint decision, which is enough to miss the 250ms window
   * on a 20ms cadence.
   */
  #lastSpeechAt: number | null = null;
  #lastPrefix = '';
  #prefixStableSince: number | null = null;

  constructor(config: Config, opts: { now?: () => number } = {}) {
    this.#config = config;
    this.#now = opts.now ?? Date.now;
  }

  push(frame: AudioFrame, partialText: string | null): void {
    const now = this.#now();
    const level = rms(frame);
    const isSpeech = level > (this.#speaking ? SPEECH_CONTINUE_RMS : SPEECH_ONSET_RMS);

    if (isSpeech) {
      this.#lastSpeechAt = now;
      if (!this.#speaking) {
        this.#speaking = true;
        for (const handler of this.#startHandlers) handler();
      }
    }

    const prefix = stablePrefix(
      partialText ?? '',
      this.#config.turn.stablePrefixDropTokens,
    );
    if (prefix !== this.#lastPrefix) {
      this.#lastPrefix = prefix;
      this.#prefixStableSince = now;
    } else {
      this.#prefixStableSince ??= now;
    }

    if (!this.#speaking || isSpeech || this.#lastSpeechAt === null) return;

    const unfinished = looksUnfinished(partialText ?? '');
    const required = unfinished
      ? this.#config.turn.unfinishedSilenceMs
      : this.#config.turn.silenceMs;

    // Spec §5: silence AND a settled transcript. Silence on its own is a timer,
    // and a timer is either slow or cuts the user off mid-thought.
    const silentFor = now - this.#lastSpeechAt;
    const stableFor = now - (this.#prefixStableSince ?? now);
    if (silentFor >= required && stableFor >= required) this.#endTurn();
  }

  onSpeechStart(cb: () => void): Unsubscribe {
    this.#startHandlers.add(cb);
    return () => this.#startHandlers.delete(cb);
  }

  onTurnEnd(cb: () => void): Unsubscribe {
    this.#endHandlers.add(cb);
    return () => this.#endHandlers.delete(cb);
  }

  #endTurn(): void {
    this.#speaking = false;
    this.#lastSpeechAt = null;
    this.#lastPrefix = '';
    this.#prefixStableSince = null;
    for (const handler of this.#endHandlers) handler();
  }
}
