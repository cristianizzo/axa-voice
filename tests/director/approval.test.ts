import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretApproval, isStopCommand } from '../../src/director/approval.ts';

test('recognises clear approval', () => {
  for (const t of ['sì', 'si', 'Sì!', 'ok', 'okay', 'vai', 'fallo', 'certo', 'va bene', 'procedi']) {
    assert.equal(interpretApproval(t), 'yes', `should approve: ${t}`);
  }
});

test('recognises clear refusal', () => {
  for (const t of ['no', 'No.', 'ferma', 'fermati', 'lascia stare', 'annulla', 'aspetta']) {
    assert.equal(interpretApproval(t), 'no', `should refuse: ${t}`);
  }
});

test('anything else is unclear, and unclear is never an approval', () => {
  for (const t of ['', '   ', 'apri il file', 'come va', 'sisma', 'cosa hai detto', 'boh']) {
    assert.notEqual(interpretApproval(t), 'yes', `must not approve: ${JSON.stringify(t)}`);
  }
});

test('hallucinated transcripts are never approvals', () => {
  // These are exactly what whisper produces for silence (spec §8). If one of
  // them ever reads as "yes", a file gets written that nobody asked for.
  for (const t of ['[Musica]', 'Sottotitoli e revisione a cura di QTSS', 'Grazie per la visione!']) {
    assert.equal(interpretApproval(t), 'unclear', `must not approve: ${t}`);
  }
});

test('a yes buried in a longer sentence does not count', () => {
  // "sì" inside a question is not consent to write a file.
  assert.notEqual(interpretApproval('non so se sì o no'), 'yes');
  assert.notEqual(interpretApproval('avevi detto di sì prima?'), 'yes');
});

// --- adversarial and ambiguous ------------------------------------------

test('a negated yes is never a yes', () => {
  for (const t of [
    'no, va bene così',
    'non va bene',
    'no vai',
    'meglio di no',
    'assolutamente no',
    'direi di no',
    'no grazie',
    'preferirei di no',
  ]) {
    assert.notEqual(interpretApproval(t), 'yes', `must not approve: ${t}`);
  }
});

test('words that merely contain a yes token are not a yes', () => {
  // Whisper is fond of these on half-heard Italian.
  for (const t of ['sisma', 'sigla', 'sito', 'siamo', 'okkio', 'certosino', 'vaia', 'sicuro che no']) {
    assert.notEqual(interpretApproval(t), 'yes', `must not approve: ${t}`);
  }
});

test('a question about approving is not an approval', () => {
  for (const t of ['devo dire sì?', 'vuoi che dica ok', 'ti va bene se aspetto', 'sì o no']) {
    assert.notEqual(interpretApproval(t), 'yes', `must not approve: ${t}`);
  }
});

test('punctuation, casing, stray whitespace and accents do not change the verdict', () => {
  assert.equal(interpretApproval('  SÌ.  '), 'yes');
  assert.equal(interpretApproval('Ok!!!'), 'yes');
  assert.equal(interpretApproval('si"'), 'yes');
  assert.equal(interpretApproval('Sí'), 'yes', 'whisper sometimes emits the acute accent');
  assert.equal(interpretApproval('NO!'), 'no');
  assert.equal(interpretApproval('va  bene'), 'yes');
});

test('common short variants of yes and no are handled', () => {
  for (const t of ['sì sì', 'si si', 'sisi', 'ok vai', 'vai pure', 'dai', 'esatto', 'confermo']) {
    assert.equal(interpretApproval(t), 'yes', `should approve: ${t}`);
  }
  for (const t of ['no no', 'nono', 'stop', 'lascia perdere', 'non farlo', 'fermo', 'annullalo']) {
    assert.equal(interpretApproval(t), 'no', `should refuse: ${t}`);
  }
});

test('an unclear utterance is distinguishable from a refusal', () => {
  // The Director denies both, but routes only the unclear one on as a new turn
  // (spec §8), so the two must not collapse into one answer.
  assert.equal(interpretApproval('che ore sono'), 'unclear');
  assert.equal(interpretApproval('no'), 'no');
});

test('bracketed noise markers never reach a verdict of yes', () => {
  for (const t of ['[Musica]', '[Applausi]', '(musica)', '[ Musica ]', '...', '♪']) {
    assert.notEqual(interpretApproval(t), 'yes', `must not approve: ${t}`);
  }
});

test('a long utterance is never an approval however it starts', () => {
  assert.notEqual(
    interpretApproval('sì allora volevo chiederti invece di controllare i log di ieri'),
    'yes',
  );
  assert.notEqual(interpretApproval('ok ma prima dimmi cosa fa quel comando'), 'yes');
});

// --- stop command ---------------------------------------------------------

test('a bare stop command stops', () => {
  for (const s of ['basta', 'stop', 'lascia stare', 'annulla', 'fermati', 'Basta.', '  STOP  ']) {
    assert.equal(isStopCommand(s), true, s);
  }
});

test('a stop word inside a longer sentence does not stop', () => {
  for (const s of [
    'non dirmi basta',
    'poi ti dico quando basta',
    'lascia stare quello e cercami il meteo',
  ]) {
    assert.equal(isStopCommand(s), false, s);
  }
});

test('aspetta does not stop, but is still a refusal for approvals', () => {
  // The two vocabularies overlap without being the same set (spec §3).
  assert.equal(isStopCommand('aspetta'), false);
  assert.equal(interpretApproval('aspetta'), 'no');
});

test('empty and hallucinated input never stops', () => {
  for (const s of ['', '   ', '[Musica]', '(rumore)']) assert.equal(isStopCommand(s), false);
});
