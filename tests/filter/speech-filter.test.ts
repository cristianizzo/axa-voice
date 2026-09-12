import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SentenceSpeechFilter, toSpokenForm } from '../../src/filter/speech-filter.ts';
import type { AgentEvent } from '../../src/types.ts';

async function* deltas(...chunks: string[]): AsyncIterable<AgentEvent> {
  for (const delta of chunks) yield { type: 'text', delta };
  yield { type: 'done' };
}

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const s of it) out.push(s);
  return out;
}

/** An event source the test drives by hand, so "did it emit yet?" is observable. */
function pushable() {
  const queue: AgentEvent[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    push(event: AgentEvent) {
      queue.push(event);
      wake?.();
      wake = undefined;
    },
    end() {
      closed = true;
      wake?.();
      wake = undefined;
    },
    async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

/** Fails loudly instead of hanging the test run when nothing is emitted. */
function withDeadline<T>(promise: Promise<T>, what: string, ms = 300): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms).unref(),
    ),
  ]);
}

test('emits a sentence as soon as it is complete, before generation ends', async () => {
  const f = new SentenceSpeechFilter();
  const out = await collect(f.filter(deltas('Ciao. ', 'Come va?')));
  assert.deepEqual(out, ['Ciao.', 'Come va?']);
});

test('splits when a capital follows the period with no space', async () => {
  // Streamed tokens arrive without tidy spacing; the prototype needed this.
  const f = new SentenceSpeechFilter();
  const out = await collect(f.filter(deltas('Fatto.Adesso controllo.')));
  assert.deepEqual(out, ['Fatto.', 'Adesso controllo.']);
});

test('never speaks a fenced code block', async () => {
  const f = new SentenceSpeechFilter();
  const out = await collect(
    f.filter(deltas('Ecco la funzione. ', '```ts\nconst x = 1;\n```', ' Fatto.')),
  );
  const joined = out.join(' ');
  assert.ok(!joined.includes('const x'), 'code must never reach the speakers');
  assert.ok(joined.includes("Te l'ho scritta"), 'but its absence must be narrated');
});

test('flushes a trailing fragment that never got its full stop', async () => {
  const f = new SentenceSpeechFilter();
  const out = await collect(f.filter(deltas('Nessun punto finale qui')));
  assert.deepEqual(out, ['Nessun punto finale qui']);
});

test('shortens file paths into something speakable', () => {
  assert.equal(toSpokenForm('src/auth/session.ts'), 'session punto ti esse, dentro auth');
  assert.equal(toSpokenForm('README.md'), 'README punto emme di');
});

test('strips markdown emphasis and list bullets', () => {
  assert.equal(toSpokenForm('**importante**'), 'importante');
  assert.equal(toSpokenForm('- primo punto'), 'primo punto');
});

// --- beyond the prototype -------------------------------------------------

test('a finished sentence is released at the end of a text block, not held for the turn', async () => {
  // Measured on the real event stream: the sentence closing a text block has no
  // whitespace after it, so a splitter that needs "punctuation + space" holds it
  // until the turn ends. When the next thing was a tool call that wait was 16 s —
  // and the held sentence was the "wait, I'm checking" filler meant to cover it.
  const source = pushable();
  const f = new SentenceSpeechFilter();
  const it = f.filter(source)[Symbol.asyncIterator]();

  source.push({ type: 'text', delta: 'Aspetta che controllo.' });
  source.push({ type: 'tool', name: 'Bash', phase: 'start' });

  const first = await withDeadline(it.next(), 'the sentence before the tool call');
  assert.equal(first.value, 'Aspetta che controllo.');

  source.end();
  await it.return?.(undefined);
});

test('a code fence split across many deltas still leaks nothing', async () => {
  // Tokens arrive a few characters at a time: the fence opens in one delta and
  // closes several deltas later. A regex that treats an unterminated fence as
  // "code, so far" destroys the buffer and lets the rest of the block through.
  const f = new SentenceSpeechFilter();
  const out = await collect(
    f.filter(
      deltas('Ecco. ', '```', 'ts\n', 'const segreto', ' = 42;\n', 'export ', 'default', '\n```', ' Fatto.'),
    ),
  );
  const joined = out.join(' ');
  assert.ok(!joined.includes('segreto'), `code leaked: ${joined}`);
  assert.ok(!joined.includes('export'), `code leaked: ${joined}`);
  assert.ok(!joined.includes('42'), `code leaked: ${joined}`);
  assert.ok(joined.includes("Te l'ho scritta"));
  assert.ok(joined.includes('Fatto.'));
});

test('an unterminated code fence is never spoken either', async () => {
  const f = new SentenceSpeechFilter();
  const out = await collect(f.filter(deltas('Guarda. ', '```ts\nconst segreto = 1;')));
  const joined = out.join(' ');
  assert.ok(!joined.includes('segreto'), `code leaked: ${joined}`);
});

test('markdown links keep the label and drop the URL', () => {
  // This exact line was read out character by character by the prototype.
  assert.equal(
    toSpokenForm(
      'Fonti: [iLMeteo](https://www.ilmeteo.it/meteo/valenza), [3BMeteo](https://www.3bmeteo.com/meteo/valenza)',
    ),
    'Fonti: iLMeteo, 3BMeteo',
  );
});

test('a bare URL becomes its host, never its path', () => {
  assert.equal(
    toSpokenForm('Guarda https://www.ilmeteo.it/meteo/valenza per i dettagli.'),
    'Guarda ilmeteo.it per i dettagli.',
  );
  assert.equal(toSpokenForm('Vedi https://esempio.it/a/b/c.'), 'Vedi esempio.it.');
});

test('strips heading markers, blockquotes and numbered list markers', () => {
  assert.equal(toSpokenForm('## Riepilogo'), 'Riepilogo');
  assert.equal(toSpokenForm('> citazione'), 'citazione');
  assert.equal(toSpokenForm('1. primo'), 'primo');
});

test('inline code is spoken as its content, not as backticks', () => {
  assert.equal(toSpokenForm('lancia `npm test` adesso'), 'lancia npm test adesso');
  assert.equal(toSpokenForm('vedi `src/auth/session.ts`'), 'vedi session punto ti esse, dentro auth');
});

test('a directory path without an extension is shortened too', () => {
  assert.equal(toSpokenForm('src/auth/session'), 'session, dentro auth');
  // Two-segment shorthands that are not paths must survive untouched.
  assert.equal(toSpokenForm('circa 100 km/h'), 'circa 100 km/h');
});

test('a path in mid-sentence does not split the sentence', async () => {
  const f = new SentenceSpeechFilter();
  const out = await collect(f.filter(deltas('Ho aggiornato src/auth/session.ts e funziona. ')));
  assert.deepEqual(out, ['Ho aggiornato session punto ti esse, dentro auth e funziona.']);
});

test('the code narration is not repeated back to back', async () => {
  const f = new SentenceSpeechFilter();
  const out = await collect(f.filter(deltas('```js\na\n```', '```js\nb\n```', ' Ecco.')));
  const joined = out.join(' ');
  const occurrences = joined.split("Te l'ho scritta").length - 1;
  assert.equal(occurrences, 1, `narrated ${occurrences} times: ${joined}`);
});

test('an empty or purely decorative delta yields nothing', async () => {
  const f = new SentenceSpeechFilter();
  assert.deepEqual(await collect(f.filter(deltas('', '   ', '\n\n'))), []);
  assert.deepEqual(await collect(f.filter(deltas('---\n'))), []);
});
