export type ApprovalAnswer = 'yes' | 'no' | 'unclear';

/**
 * Accent-free, punctuation-free forms. Normalisation folds "sì", "si" and the
 * acute "sí" whisper sometimes emits onto the same key.
 */
const YES = new Set([
  'si', 'si si', 'sisi', 'sissi', 'si ok', 'si vai', 'si fallo', 'si certo',
  'si dai', 'si va bene', 'si grazie', 'si procedi',
  'ok', 'ok ok', 'okay', 'okey', 'oke', 'ok vai', 'ok fallo', 'ok procedi',
  'vai', 'vai pure', 'vai avanti', 'fallo', 'fallo pure', 'fai pure', 'puoi farlo',
  'certo', 'certamente', 'va bene', 'vabene', 'procedi', 'conferma', 'confermo',
  'avanti', 'perfetto', 'esatto', 'dai', 'approvato', 'autorizzo',
  'd accordo', 'sono d accordo',
]);

const NO = new Set([
  'no', 'no no', 'nono', 'noo', 'no grazie', 'assolutamente no', 'direi di no',
  'preferirei di no', 'meglio di no', 'no lascia stare',
  'ferma', 'fermati', 'fermo', 'stop', 'annulla', 'annullalo', 'annullare',
  'lascia stare', 'lascia perdere', 'aspetta', 'aspetta un attimo',
  'non farlo', 'non voglio', 'non serve', 'niente', 'basta', 'nega',
]);

/**
 * Longer than this and it is a sentence, not an answer. Defence in depth: the
 * sets above are matched whole, so nothing long can reach them anyway.
 */
const MAX_WORDS = 4;

/** Lowercase, strip accents and every non-alphanumeric character, collapse spaces. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Fail closed: only a short, unambiguous utterance counts as consent.
 *
 * Deliberately NOT a substring search. "non so se sì o no" contains "sì", and
 * approving it would write a file the user never asked for. The whole utterance
 * must be the answer — anything longer is a new turn, not a confirmation, and
 * the Director routes it on as one (spec §8).
 *
 * `'no'` and `'unclear'` are both denials. They stay distinct only so the
 * Director knows whether the utterance was an answer or a new request.
 */
export function interpretApproval(text: string): ApprovalAnswer {
  const normalised = normalise(text);

  if (!normalised) return 'unclear';
  if (normalised.split(' ').length > MAX_WORDS) return 'unclear';
  if (YES.has(normalised)) return 'yes';
  if (NO.has(normalised)) return 'no';
  return 'unclear';
}
