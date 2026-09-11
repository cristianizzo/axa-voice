#!/usr/bin/env node
// Controlla che la chiave Cartesia funzioni e mostra le voci italiane.
// Non scrive niente, non manda audio. Solo una GET per elencare le voci.

import { readFile } from 'node:fs/promises';

const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
const key = env.match(/CARTESIA_API_KEY=(.+)/)?.[1]?.trim();
if (!key) throw new Error('CARTESIA_API_KEY non trovata in .env');

console.log(`chiave letta da .env: sk_car_…${key.slice(-4)}`);

const res = await fetch('https://api.cartesia.ai/voices/?limit=100', {
  headers: { 'X-API-Key': key, 'Cartesia-Version': '2024-11-13' },
});

console.log(`risposta: HTTP ${res.status}`);
if (!res.ok) {
  console.log(await res.text());
  process.exit(1);
}

const body = await res.json();
const voices = Array.isArray(body) ? body : (body.data ?? []);
console.log(`voci disponibili: ${voices.length}`);

const italian = voices.filter((v) => v.language === 'it');
console.log(`\nvoci italiane (${italian.length}):`);
for (const v of italian) console.log(`  ${v.id}  ${v.name}`);

if (!italian.length) {
  console.log('\nnessuna voce marcata "it". Prime 5 voci disponibili:');
  for (const v of voices.slice(0, 5)) console.log(`  ${v.id}  ${v.name} [${v.language}]`);
}
