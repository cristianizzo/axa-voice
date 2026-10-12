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
// 2026-09-26: switching stt.modelPath to large-v3-turbo (src/config.ts) surfaced
// more of whisper.cpp's well-known YouTube-subtitle sign-off hallucinations on
// silence/background noise. THANKS_BOILERPLATE alone ("grazie" / "grazie per
// la visione") didn't cover them, so the list below is broadened to the other
// stock phrases the same training data produces.
const THANKS_BOILERPLATE = /^\s*grazie(\s+(per\s+la\s+visione|a\s+tutti|mille|di\s+aver\s+guardato|per\s+l['’]attenzione))?\s*!?\s*$/i;
const SUBSCRIBE_BOILERPLATE = /^\s*iscrivetevi(\s+al\s+canale)?\s*!?\s*$/i;
const TRAILING_PUNCTUATION = /[.,;:!?…\s]+$/;

export function clean(raw: string): string {
  const text = raw
    .replace(BRACKETED, ' ')
    .replace(SUBTITLE_BOILERPLATE, ' ')
    .replace(TRAILING_PUNCTUATION, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (THANKS_BOILERPLATE.test(text) || SUBSCRIBE_BOILERPLATE.test(text)) return '';
  return text.length < 2 ? '' : text;
}
