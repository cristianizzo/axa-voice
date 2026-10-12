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

/**
 * Onset threshold used instead of `SPEECH_ONSET_RMS` while the Director is
 * speaking through the same device (`selfPlayActive`, see `TurnDetector.push`'s
 * doc comment). AEC's own measured attenuation ranges from +15.6 dB down to
 * +0.7 dB depending on the content (spec 2026-09-11 §6) — nothing here can
 * assume it removed the echo, only that it made it quieter on average. 3x
 * approximates the weaker, more common end of that range in *linear* RMS
 * terms (~9.5 dB): high enough that ordinary residual echo from the
 * Director's own voice does not re-cross the bar it was just measured
 * against, low enough that a user actually trying to interrupt — speaking
 * into the mic at normal distance, not through a speaker and back — still
 * clears it without having to raise their voice. It only ever gates the
 * *onset*; once real speech is already recognised, `SPEECH_CONTINUE_RMS`
 * governs same as any other utterance.
 *
 * That handoff is only fully safe in SPEAKING: a genuine barge-in there does
 * flush playback (`#onSpeechStart` -> `#muteForBargeIn` in director.ts), so
 * residual echo has nothing left to feed `SPEECH_CONTINUE_RMS` afterwards.
 * `director.ts`'s `#onFrame` deliberately passes `audioOut.isPlaying()`
 * rather than gating on `#state === 'SPEAKING'`, so this raised onset bar
 * also applies while THINKING and AWAITING_APPROVAL — during a progress
 * line or an approval question. In those two states `#onSpeechStart`
 * returns without touching playback at all (AWAITING_APPROVAL) or leaves it
 * running by design (THINKING, so talking during it can add to the
 * conversation instead of destroying it). There, once the raised bar
 * correctly suppresses a false onset, playback keeps running and residual
 * echo only has to clear the much lower `SPEECH_CONTINUE_RMS` to keep
 * refreshing "still speaking" and delay `onTurnEnd` until the line finishes.
 */
const SPEECH_ONSET_RMS_SELF_PLAY = 1500;

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

  push(frame: AudioFrame, partialText: string | null, selfPlayActive = false): void {
    const now = this.#now();
    const level = rms(frame);
    const onsetRms = selfPlayActive ? SPEECH_ONSET_RMS_SELF_PLAY : SPEECH_ONSET_RMS;
    const isSpeech = level > (this.#speaking ? SPEECH_CONTINUE_RMS : onsetRms);

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
