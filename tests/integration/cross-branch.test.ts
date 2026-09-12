// Does the AgentSession's end-of-block signal actually make the SpeechFilter
// release the held sentence? The two were written by different agents from the
// same interface and never ran together. This is the 16s stall.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent } from '../../src/types.ts';
import { SentenceSpeechFilter } from '../../src/filter/speech-filter.ts';

async function* events(list: AgentEvent[]) { for (const e of list) yield e; }

test('a sentence ending a text block is released before the tool runs', async () => {
  // Exactly what the session emits: the filler, then block stop, then a tool.
  const stream = events([
    { type: 'text', delta: 'Aspet' },
    { type: 'text', delta: 'ta che' },
    { type: 'text', delta: ' guardo...' },
    { type: 'text', delta: '\n' },              // content_block_stop
    { type: 'tool', name: 'WebSearch', phase: 'start' },
  ]);
  const out: string[] = [];
  for await (const s of new SentenceSpeechFilter().filter(stream)) out.push(s);
  assert.ok(out.length > 0, 'the filler must be spoken BEFORE the search, not after it');
  assert.match(out[0]!, /aspetta che guardo/i);
});

test('the sources line is never dictated as a URL', async () => {
  // Verbatim from a real prototype turn tonight: it read the whole URL out,
  // character by character. This is the failure the README uses to explain
  // why Siri is unusable for a coding assistant.
  const stream = events([
    { type: 'text', delta: 'Oggi a Valencia 27 gradi.\n' },
    { type: 'text', delta: 'Fonti: [iLMeteo](https://www.ilmeteo.it/meteo/valenza).\n' },
    { type: 'done' },
  ]);
  const spoken = [];
  for await (const s of new SentenceSpeechFilter().filter(stream)) spoken.push(s);
  const all = spoken.join(' ');
  assert.ok(!all.includes('https'), `scheme must never be spoken: ${all}`);
  assert.ok(!all.includes('/meteo/valenza'), `path must never be spoken: ${all}`);
});
