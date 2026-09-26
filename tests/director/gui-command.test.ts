import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretGuiCommand } from '../../src/director/gui-command.ts';

test('the exact phrases the feature was designed around still match', () => {
  assert.equal(interpretGuiCommand('attiva la gui'), 'on');
  assert.equal(interpretGuiCommand('disattiva la gui'), 'off');
});

test('what whisper actually produced live: "gui" and "on" merged into one token', () => {
  assert.equal(interpretGuiCommand('Attiva guion'), 'on');
  assert.equal(interpretGuiCommand('Gui on'), 'on');
});

test('the off equivalent of the merged-token case', () => {
  assert.equal(interpretGuiCommand('Gui off'), 'off');
  assert.equal(interpretGuiCommand('spegni guioff'), 'off');
});

test('"gui" said inside an ordinary sentence is not a command', () => {
  assert.equal(interpretGuiCommand('non so cosa sia la gui di questo programma'), null);
});

test('a similar-looking unrelated word never fires the toggle', () => {
  // "guida" (guide) starts with the same three letters as "gui" and the
  // sentence also carries an on-signal word ("apri") — exactly the shape a
  // fuzzy prefix match would get wrong.
  assert.equal(interpretGuiCommand('apri la guida'), null);
});

test('both an on-word and an off-word in the same utterance is not a clear instruction', () => {
  assert.equal(interpretGuiCommand('attiva o disattiva la gui'), null);
});

test('neither an on-word nor an off-word is not a command, just the word gui', () => {
  assert.equal(interpretGuiCommand('gui'), null);
});
