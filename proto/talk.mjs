#!/usr/bin/env node
// PROTOTIPO USA-E-GETTA. Da buttare dopo averlo provato.
// Serve solo a farti sentire con le orecchie: latenza, voce, e il trucco
// di iniziare a parlare prima che Claude abbia finito di scrivere.
//
// NON c'è: cancellazione dell'eco, interruzione, rilevamento fine turno.
// Quelli sono M1, e vanno fatti per bene. Qui si preme INVIO.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { unlink, writeFile, readFile } from 'node:fs/promises';

// Le chiavi stanno in .env, che git ignora. Mai nel codice.
try {
  process.loadEnvFile(new URL('../.env', import.meta.url).pathname);
} catch {
  // nessun .env: si usa la voce di macOS
}

const MODEL = new URL('./models/ggml-small.bin', import.meta.url).pathname;
const AXA = '/Users/cristianizzo/Developers/axa-chat/cli-dev';
const WAV = '/tmp/axa-voice-in.wav';

const SYSTEM = `Stai parlando a voce, non scrivendo. Chi ti ascolta non vede lo schermo mentre parli.
- Frasi corte, parlato vero, come una persona al telefono.
- Mai leggere codice ad alta voce. Se hai scritto del codice di' solo cosa fa.
- Mai elenchi puntati parlati, mai "Certamente! Ecco i tre passaggi".
- I percorsi dei file accorciali: "src/auth/session.ts" si dice "session, dentro auth".
- Rispondi nella lingua in cui ti hanno parlato.
- Sii breve. Due o tre frasi, a meno che non ti chiedano di dilungarti.

Hai strumenti veri e funzionanti: cerca sul web, leggi file, lancia comandi.
Se ti chiedono di controllare qualcosa, CONTROLLA davvero. Non dire mai
"non ho accesso a internet" o "non posso verificare": puoi, usali.
Se un controllo richiede qualche secondo, dillo prima con mezza frase
("aspetta che guardo") così chi ascolta non resta nel silenzio.`;

const t = () => Date.now();
const ms = (a, b) => `${String(b - a).padStart(5)}ms`;

/** Registra finché l'utente non preme INVIO di nuovo. */
async function record(rl) {
  const sox = spawn('sox', ['-d', '-r', '16000', '-c', '1', '-b', '16', WAV], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await rl.question('\x1b[31m● registrando…\x1b[0m  INVIO per fermare ');
  sox.kill('SIGTERM');
  await new Promise((r) => sox.on('close', r));
}

const PORT = 8178;

/**
 * Whisper resta acceso come server. Non è un dettaglio: lanciarlo da capo
 * a ogni frase costa 17 secondi di caricamento del modello, tenerlo caldo
 * lo porta a 0,15. Nel progetto vero è per lo stesso motivo che l'STT
 * è un flusso aperto e non una chiamata.
 */
async function startWhisper() {
  if (await alive()) return null;
  const s = spawn('whisper-server', ['-m', MODEL, '--port', String(PORT), '-t', '8'], {
    stdio: 'ignore',
    detached: false,
  });
  process.stdout.write('carico whisper');
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    process.stdout.write('.');
    if (await alive()) { console.log(' pronto'); return s; }
  }
  throw new Error('whisper-server non è partito');
}

async function alive() {
  try {
    await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(300) });
    return true;
  } catch { return false; }
}

/** Whisper in locale: wav -> testo. */
async function transcribe() {
  const form = new FormData();
  form.append('file', new Blob([await readFile(WAV)]), 'a.wav');
  form.append('language', 'it');
  form.append('response_format', 'text');
  const res = await fetch(`http://127.0.0.1:${PORT}/inference`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(`whisper ha risposto ${res.status}`);
  return clean(await res.text());
}

/**
 * Whisper, sul silenzio o sul rumore, si inventa roba: "[Musica]", "(applausi)",
 * "Sottotitoli e revisione a cura di...". Sono allucinazioni note del modello,
 * non parole tue. Se le lasci passare, l'agente risponde al nulla.
 */
function clean(raw) {
  const text = raw
    .replace(/[\[\(\*][^\])*]*[\])\*]/g, ' ')       // [Musica], (applausi), *ride*
    .replace(/sottotitoli.*$/gis, ' ')              // code di sottotitolaggio
    .replace(/[.,;:!?…\s]+$/, '')                   // punteggiatura penzolante
    .replace(/\s+/g, ' ')
    .trim();
  // le parole singole valgono ("ferma", "aspetta", "sì"), i frammenti no
  return text.length < 2 ? '' : text;
}

/**
 * Claude, UN SOLO processo tenuto vivo per tutta la sessione.
 *
 * Misurato sul posto, e sono i due numeri che decidono il progetto:
 *   processo nuovo a ogni frase, con gli MCP accesi ... 7-10 s
 *   processo nuovo, MCP spenti .................... 2,4 s
 *   processo unico tenuto vivo, MCP spenti ........ 1,37 s
 *
 * Gli MCP (logzio, mongo, gdrive…) si riconnettono a ogni avvio e da soli
 * costavano 5-7 secondi a turno. Qui li spengo del tutto; nella versione
 * vera vanno caricati pigramente, alla prima volta che servono davvero.
 */
function startClaude() {
  const c = spawn(AXA, [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages', '--verbose',
    '--model', 'sonnet',
    '--append-system-prompt', SYSTEM,
    '--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config',
  ], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: '/Users/cristianizzo/.claude' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  let line = '';
  let buf = '';
  let queue = [];
  let turnDone = true;
  let wake = () => {};

  c.stdout.on('data', (chunk) => {
    line += chunk;
    const lines = line.split('\n');
    line = lines.pop();
    for (const l of lines) {
      if (!l.trim()) continue;
      let msg;
      try { msg = JSON.parse(l); } catch { continue; }

      if (msg.type === 'result') { turnDone = true; wake(); continue; }
      if (msg.type !== 'stream_event') continue;
      const ev = msg.event;
      if (ev?.type !== 'content_block_delta' || ev.delta?.type !== 'text_delta') continue;

      buf += ev.delta.text;
      // taglia su fine frase: è l'unità più piccola che si può già dire,
      // e non aspetta che Claude abbia finito il resto della risposta
      let m;
      while ((m = buf.match(/^([\s\S]*?[.!?…]["')\]]?)(\s+)/))) {
        queue.push(m[1].trim());
        buf = buf.slice(m[0].length);
        wake();
      }
    }
  });

  let closing = false;
  c.on('exit', (code) => {
    if (closing) return;
    console.error(`\n\x1b[31mClaude è uscito (codice ${code}). Riavvia il prototipo.\x1b[0m`);
    process.exit(1);
  });

  return {
    close() { closing = true; c.kill(); },
    async *ask(prompt) {
      buf = ''; queue = []; turnDone = false;
      c.stdin.write(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: prompt }] },
      }) + '\n');

      while (!turnDone || queue.length) {
        if (queue.length) { yield queue.shift(); continue; }
        await new Promise((r) => (wake = r));
      }
      if (buf.trim()) yield buf.trim();
    },
  };
}

/** Toglie quello che non si può dire a voce. Versione grezza. */
function speakable(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' — te l\'ho scritta, guarda lo schermo. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/[*_#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * La voce. Nello spec è un'interfaccia sostituibile: qui si vede perché.
 * Se metti ELEVENLABS_API_KEY nell'ambiente, cambia da sola.
 */
const voice = process.env.CARTESIA_API_KEY ? cartesia
  : process.env.ELEVENLABS_API_KEY ? elevenlabs
  : macSay;
const voiceName = voice === cartesia ? 'Cartesia'
  : voice === elevenlabs ? 'ElevenLabs'
  : 'macOS say (metti una chiave in .env per sentire la differenza)';

function macSay(text) {
  return new Promise((resolve) => {
    const s = spawn('say', ['-r', '190', text]);
    s.on('close', resolve);
  });
}

/** Riproduce un file audio e lo cancella. */
async function play(file) {
  await new Promise((r) => spawn('afplay', [file]).on('close', r));
  await unlink(file).catch(() => {});
}

async function cartesia(text) {
  // voci italiane disponibili: node proto/check-cartesia.mjs
  const VOICE_ID = process.env.CARTESIA_VOICE_ID || 'c8403b5c-6465-4396-9065-a440d376528a';
  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      'X-API-Key': process.env.CARTESIA_API_KEY,
      'Cartesia-Version': '2024-11-13',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model_id: 'sonic-3',
      transcript: text,
      voice: { mode: 'id', id: VOICE_ID },
      output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 24000 },
      language: 'it',
    }),
  });
  if (!res.ok) {
    console.error(`\x1b[31mCartesia ha risposto ${res.status}: ${await res.text()}\x1b[0m`);
    return macSay(text);
  }
  const f = `/tmp/axa-voice-out-${Date.now()}.wav`;
  await writeFile(f, Buffer.from(await res.arrayBuffer()));
  await play(f);
}

async function elevenlabs(text) {
  const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb';
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_22050_32`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
    },
  );
  if (!res.ok) {
    console.error(`\x1b[31mElevenLabs ha risposto ${res.status}, uso la voce di macOS\x1b[0m`);
    return macSay(text);
  }
  const f = `/tmp/axa-voice-out-${Date.now()}.mp3`;
  await writeFile(f, Buffer.from(await res.arrayBuffer()));
  await play(f);
}

/** Un turno: testo -> frasi dette a voce. Stampa i tempi. */
async function turn(claude, heard, t0, t1) {
  console.log(`\x1b[2m tu:\x1b[0m ${heard}`);
  let first = null;
  for await (const sentence of claude.ask(heard)) {
    if (!first) {
      first = t();
      console.log(
        `\x1b[2m trascrizione ${ms(t0, t1)} · prima frase ${ms(t1, first)} · totale al primo suono ${ms(t0, first)}\x1b[0m`,
      );
    }
    const say = speakable(sentence);
    if (!say) continue;
    console.log(`\x1b[36m lui:\x1b[0m ${say}`);
    await voice(say);
  }
  console.log();
}

async function main() {
  console.log(`\x1b[1maxa-voice — prototipo\x1b[0m`);
  console.log(`voce: ${voiceName}`);

  const claude = startClaude();

  // prova senza microfono:  node proto/talk.mjs --say "ciao come stai"
  const i = process.argv.indexOf('--say');
  if (i !== -1) {
    const now = t();
    await turn(claude, process.argv[i + 1], now, now);
    claude.close();
    return;
  }

  // Scalda Claude mentre whisper carica il modello: l'avvio del processo
  // costa ~3s, ma qui è tempo che stiamo già aspettando comunque.
  const warm = (async () => { for await (const _ of claude.ask('Rispondi solo: ok')) {} })();
  const server = await startWhisper();
  await warm;
  process.on('SIGINT', () => { server?.kill(); claude.close(); process.exit(0); });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`ctrl-c per uscire\n`);

  for (;;) {
    await rl.question('INVIO per parlare ');
    await record(rl);

    const t0 = t();
    const heard = await transcribe();
    const t1 = t();

    if (!heard) { console.log('non ho sentito niente\n'); continue; }
    await turn(claude, heard, t0, t1);
  }
}

main();
