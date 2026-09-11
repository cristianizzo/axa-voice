// Misura il tempo al primo token di Claude: la voce piu' grossa del budget (§4).
//
// Il primo turno paga l'avvio e succede una volta sola. Quello che conta per la
// voce e' il turno N, quindi ne misuro quattro nella STESSA sessione tenendo lo
// stream di input aperto.
//
// Questo NON e' un dettaglio: misurando un turno per sessione viene 6-7 secondi,
// un numero che sembra vero e non lo e'. Il test di latenza automatico deve
// misurare il turno N, mai il turno 1.
//
// Richiede l'SDK:  npm i @anthropic-ai/claude-agent-sdk
// Uso:             node proto/check-ttft.mjs

import { startup } from '@anthropic-ai/claude-agent-sdk';

const DOMANDE = [
  'Di\' solo: uno.',
  'Di\' solo: due.',
  'Di\' solo: tre.',
  'Di\' solo: quattro.',
];

// Coda che tiene vivo lo stream di input: la sessione resta aperta
// finche' non chiudiamo noi.
function inputQueue() {
  const pending = [];
  let notify = null;
  const iterator = (async function* () {
    for (;;) {
      if (!pending.length) await new Promise((r) => { notify = r; });
      const next = pending.shift();
      if (next === null) return;
      yield { type: 'user', message: { role: 'user', content: next }, parent_tool_use_id: null };
    }
  })();
  return {
    iterator,
    push(text) { pending.push(text); notify?.(); notify = null; },
    end() { pending.push(null); notify?.(); notify = null; },
  };
}

const t0 = Date.now();
const warm = await startup({
  options: {
    model: 'sonnet',
    includePartialMessages: true,
    strictMcpConfig: true,
    mcpServers: {},
    settingSources: ['user'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Rispondi brevissimo.' },
  },
});
console.log(`prewarm: ${Date.now() - t0} ms`);

const q = inputQueue();
const stream = warm.query(q.iterator);

let askedAt = 0;
let firstTokenMs = null;
let turn = 0;

q.push(DOMANDE[turn]);
askedAt = Date.now();

for await (const msg of stream) {
  if (msg.type === 'stream_event'
      && msg.event.type === 'content_block_delta'
      && msg.event.delta.type === 'text_delta') {
    firstTokenMs ??= Date.now() - askedAt;
  }
  if (msg.type === 'result') {
    console.log(`turno ${turn + 1}: primo token ${String(firstTokenMs).padStart(5)} ms   turno intero ${Date.now() - askedAt} ms`);
    turn += 1;
    if (turn >= DOMANDE.length) { q.end(); break; }
    firstTokenMs = null;
    q.push(DOMANDE[turn]);
    askedAt = Date.now();
  }
}

warm.close();
