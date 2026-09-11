#!/usr/bin/env node
// Misura la latenza del TTS in streaming (WebSocket), non di /tts/bytes.
// Manda una frase in due pezzi e cronometra QUANDO ARRIVA IL PRIMO AUDIO.
// Quel numero e' la riga "TTS first audio chunk" del budget di latenza.
//
// Non salva niente, non riproduce niente. Stampa numeri e basta.

import { readFile } from 'node:fs/promises';

const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
const key = env.match(/CARTESIA_API_KEY=(.+)/)?.[1]?.trim();
if (!key) throw new Error('CARTESIA_API_KEY non trovata in .env');

const VERSION = '2026-08-14';
const VOICE = 'c8403b5c-6465-4396-9065-a440d376528a';
const MODELS = ['sonic-3.6', 'sonic-3.5', 'sonic-3'];

// Due pezzi, come li manderebbe il SpeechFilter frase per frase.
const CHUNKS = ['Ciao, ti sto rispondendo a voce. ', 'Questa e la seconda frase.'];

async function measure(model) {
  const url = `wss://api.cartesia.ai/tts/websocket?cartesia_version=${VERSION}&api_key=${key}`;
  const ws = new WebSocket(url);

  const started = Date.now();
  let firstChunkAt = null;
  let bytes = 0;

  const finished = new Promise((resolve, reject) => {
    ws.addEventListener('error', () => reject(new Error('connessione fallita')));
    ws.addEventListener('close', (e) => resolve({ closed: e.code }));
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'chunk') {
        firstChunkAt ??= Date.now();
        bytes += Buffer.from(msg.data, 'base64').length;
      } else if (msg.type === 'done') {
        ws.close();
        resolve({});
      } else if (msg.type === 'error') {
        ws.close();
        reject(new Error(msg.message ?? msg.title));
      }
    });
  });

  await new Promise((ok, ko) => {
    ws.addEventListener('open', ok, { once: true });
    ws.addEventListener('error', () => ko(new Error('open fallita')), { once: true });
  });

  const sentAt = Date.now();
  CHUNKS.forEach((transcript, i) => {
    ws.send(JSON.stringify({
      model_id: model,
      context_id: 'misura',
      transcript,
      voice: { mode: 'id', id: VOICE },
      language: 'it',
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
      continue: i < CHUNKS.length - 1,
    }));
  });

  await finished;

  // 24000 campioni/s x 2 byte = 48000 byte al secondo di audio.
  const audioMs = Math.round((bytes / 48000) * 1000);
  return {
    firstChunkMs: firstChunkAt - sentAt,
    totalMs: Date.now() - started,
    audioMs,
  };
}

for (const model of MODELS) {
  try {
    const r = await measure(model);
    console.log(
      `${model.padEnd(10)} primo audio ${String(r.firstChunkMs).padStart(5)} ms` +
      `   totale ${String(r.totalMs).padStart(5)} ms` +
      `   audio prodotto ${r.audioMs} ms`,
    );
  } catch (err) {
    console.log(`${model.padEnd(10)} ERRORE: ${err.message}`);
  }
}
