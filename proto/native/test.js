// Node harness: drives ./aecio, feeds a tone, captures mic, measures flush latency.
const { spawn } = require('child_process');
const fs = require('fs');

const RATE = Number(process.env.RATE || 24000);
const MIC_RATE = Number(process.env.MIC_RATE || 16000);
const BUF = process.env.BUF || '0';
const TONE = process.env.TONE === '1';

const args = ['--rate', String(RATE), '--mic-rate', String(MIC_RATE)];
if (BUF !== '0') args.push('--buffer-frames', BUF);

const p = spawn('./aecio', args, { stdio: ['pipe', 'pipe', 'pipe'] });

let micBytes = 0;
const micChunks = [];
let firstMicAt = null;
const t0 = Date.now();

p.stdout.on('data', (d) => {
  if (firstMicAt === null) firstMicAt = Date.now() - t0;
  micBytes += d.length;
  micChunks.push(d);
});

let events = [];
let acc = '';
p.stderr.on('data', (d) => {
  acc += d.toString();
  let i;
  while ((i = acc.indexOf('\n')) >= 0) {
    const line = acc.slice(0, i); acc = acc.slice(i + 1);
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); events.push({ ...e, at: Date.now() - t0 }); console.log('EVENT', JSON.stringify(e)); }
    catch { console.log('RAW', line); }
  }
});

function frame(cmd, payload = Buffer.alloc(0)) {
  const h = Buffer.alloc(5);
  h.write(cmd, 0, 'ascii');
  h.writeUInt32LE(payload.length, 1);
  return Buffer.concat([h, payload]);
}

// 440 Hz tone, PCM16 mono @ RATE
function tone(ms, freq = 440, startPhase = 0) {
  const n = Math.floor((RATE * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * freq * (startPhase + i) / RATE)), i * 2);
  }
  return b;
}

function rms(buf) {
  let s = 0; const n = buf.length / 2;
  for (let i = 0; i < n; i++) { const v = buf.readInt16LE(i * 2); s += v * v; }
  return Math.sqrt(s / Math.max(1, n));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await sleep(600);

  // ---- phase 1: 1 s with no playback at all -> pure mic capture
  const mark1 = micBytes;
  await sleep(1000);
  const phase1 = Buffer.concat(micChunks).slice(mark1);
  console.log(`\n[phase1 mic only] bytes=${phase1.length} expected≈${MIC_RATE * 2} rms=${rms(phase1).toFixed(1)}`);

  if (TONE) {
    // ---- phase 2: stream 3 s of tone, then flush mid-way and time the silence
    console.log('\n[phase2] streaming tone...');
    let phase = 0;
    const chunkMs = 20;
    const total = 3000;
    let sent = 0;
    const timer = setInterval(() => {
      if (sent >= total) return;
      const t = tone(chunkMs, 440, phase);
      phase += (RATE * chunkMs) / 1000;
      p.stdin.write(frame('A', t));
      sent += chunkMs;
    }, chunkMs);

    await sleep(1500);
    const flushSentAt = Date.now() - t0;
    console.log(`[phase2] sending FLUSH at t=${flushSentAt}ms`);
    p.stdin.write(frame('F'));
    clearInterval(timer);
    await sleep(800);
    const fl = events.find((e) => e.type === 'flushed');
    if (fl) console.log(`[phase2] flush ack latency = ${fl.at - flushSentAt} ms; heardMs=${fl.heardMs.toFixed(1)} consumedMs=${fl.consumedMs.toFixed(1)}`);
  }

  const mark2 = micBytes;
  await sleep(1000);
  const phase3 = Buffer.concat(micChunks).slice(mark2);
  console.log(`\n[phase3 mic] bytes=${phase3.length} rms=${rms(phase3).toFixed(1)}`);

  const all = Buffer.concat(micChunks);
  let nonZero = 0, min = 32767, max = -32768;
  for (let i = 0; i < all.length / 2; i++) {
    const v = all.readInt16LE(i * 2);
    if (v !== 0) nonZero++;
    if (v < min) min = v; if (v > max) max = v;
  }
  console.log(`\n=== TOTALS ===`);
  console.log(`first mic byte at   : ${firstMicAt} ms after spawn`);
  console.log(`total mic bytes     : ${all.length}`);
  console.log(`samples             : ${all.length / 2}`);
  console.log(`non-zero samples    : ${nonZero} (${((100 * nonZero) / (all.length / 2)).toFixed(1)}%)`);
  console.log(`min/max             : ${min}/${max}`);
  console.log(`overall RMS         : ${rms(all).toFixed(1)}`);
  console.log(`VERDICT             : ${nonZero > 0 ? 'REAL MICROPHONE AUDIO' : 'ALL ZEROS - silence/TCC block'}`);
  fs.writeFileSync('/tmp/vpio/mic.raw', all);

  p.stdin.write(frame('Q'));
  await sleep(300);
  p.kill();
  process.exit(0);
})();
