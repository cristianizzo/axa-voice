import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clean } from '../../src/stt/clean.ts';

test('strips the hallucinations whisper emits for silence', () => {
  for (const raw of [
    ' [Musica]\n', '[Applausi]', '(musica)', '*musica*',
    'Sottotitoli e revisione a cura di QTSS',
    'sottotitoli e revisione a cura di QTSS\n',
    'Grazie per la visione!',
  ]) {
    assert.equal(clean(raw), '', `should have been dropped: ${JSON.stringify(raw)}`);
  }
});

test('keeps short real words — they are the whole approval vocabulary', () => {
  // A minimum WORD count would drop every one of these (spec §8).
  assert.equal(clean('sì'), 'sì');
  assert.equal(clean(' No. '), 'No');
  assert.equal(clean('ferma'), 'ferma');
  assert.equal(clean('ok'), 'ok');
  assert.equal(clean('vai'), 'vai');
});

test('keeps ordinary sentences intact apart from trailing punctuation', () => {
  assert.equal(
    clean('  Ciao, puoi controllare i log di ieri per favore?  '),
    'Ciao, puoi controllare i log di ieri per favore',
  );
});

test('drops single characters and empty input', () => {
  assert.equal(clean(''), '');
  assert.equal(clean('   '), '');
  assert.equal(clean('a'), '');
  assert.equal(clean('.'), '');
});

test('strips a bracketed marker but keeps real speech around it', () => {
  assert.equal(clean('[Musica] apri il file'), 'apri il file');
});

test('collapses internal whitespace', () => {
  assert.equal(clean('apri    il\n\nfile'), 'apri il file');
});
