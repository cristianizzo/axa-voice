import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressLine } from '../../src/director/progress.ts';

test('names the action, never the tool or its arguments', () => {
  assert.equal(progressLine('WebSearch', 0), 'Sto cercando sul web.');
  assert.equal(progressLine('Read', 0), 'Sto leggendo.');
  for (const tool of ['WebSearch', 'Read', 'Bash', 'Inventato']) {
    const line = progressLine(tool, 0);
    assert.ok(!line.includes(tool), `${tool} leaked into speech`);
    assert.ok(!/[/_]|\.ts\b/.test(line), `${line} reads like a path (§7)`);
  }
});

test('an unknown tool still says something human', () => {
  assert.ok(progressLine('QualcosaDiNuovo', 0).length > 0);
});

test('consecutive lines differ', () => {
  assert.notEqual(progressLine('WebSearch', 0), progressLine('WebSearch', 1));
});
