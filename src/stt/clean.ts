/**
 * Whisper emits confident text for silence. Silero VAD at the server stops most
 * of it (spec §8), but a cough or a keyboard clack still reaches the decoder and
 * still becomes a sentence, so this runs on every transcript.
 *
 * Rule that must not be "simplified": the length test is on CHARACTERS, never on
 * words. "sì", "no" and "ferma" are the entire approval vocabulary (spec §8) and
 * a minimum word count would silently delete them.
 */
const BRACKETED = /[\[\(\*][^\])*]*[\])\*]/g;
const SUBTITLE_BOILERPLATE = /sottotitoli.*$/gis;
const THANKS_BOILERPLATE = /^\s*grazie(\s+per\s+la\s+visione)?\s*!?\s*$/i;
const TRAILING_PUNCTUATION = /[.,;:!?…\s]+$/;

export function clean(raw: string): string {
  const text = raw
    .replace(BRACKETED, ' ')
    .replace(SUBTITLE_BOILERPLATE, ' ')
    .replace(TRAILING_PUNCTUATION, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (THANKS_BOILERPLATE.test(text)) return '';
  return text.length < 2 ? '' : text;
}
