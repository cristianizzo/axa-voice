import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CartesiaVoice } from '../../src/voice/cartesia.ts';
import { loadConfig } from '../../src/config.ts';

const config = loadConfig({ CARTESIA_API_KEY: 'sk_test' });

class FakeSocket extends EventTarget {
  sent: string[] = [];
  /** CONNECTING until open() is called, like the real thing. */
  readyState = 0;
  closed = false;
  /** undici fires `error` on its way down when close() interrupts a connection. */
  errorOnClose = false;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    if (this.errorOnClose) this.dispatchEvent(new Event('error'));
    this.dispatchEvent(new Event('close'));
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  message(payload: unknown) {
    this.raw(JSON.stringify(payload));
  }
  raw(data: string) {
    this.dispatchEvent(Object.assign(new Event('message'), { data }));
  }
}

async function* sentences(...items: string[]) {
  for (const s of items) yield s;
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('streams sentences incrementally under one context_id', async () => {
  const socket = new FakeSocket();
  const voice = new CartesiaVoice(config, { connect: () => socket as never });
  const frames: Int16Array[] = [];

  const pump = (async () => {
    for await (const f of voice.synthesize(sentences('Uno.', 'Due.'), new AbortController().signal)) {
      frames.push(f);
    }
  })();

  await tick(10);
  socket.open();
  await tick(20);

  const payloads = socket.sent.map((s) => JSON.parse(s));
  assert.equal(payloads.length, 3, 'two sentences plus the end-of-input marker');
  assert.equal(payloads[0].continue, true);
  assert.equal(payloads[2].continue, false, 'the last message must close the context');
  assert.equal(new Set(payloads.map((p) => p.context_id)).size, 1, 'one context only');

  socket.message({ type: 'chunk', data: Buffer.from(new Int16Array([1, 2, 3]).buffer).toString('base64') });
  socket.message({ type: 'done' });
  await pump;
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0]!], [1, 2, 3]);
});

test('aborting stops the stream promptly', async () => {
  const socket = new FakeSocket();
  const voice = new CartesiaVoice(config, { connect: () => socket as never });
  const controller = new AbortController();

  const pump = (async () => {
    const out: Int16Array[] = [];
    for await (const f of voice.synthesize(sentences('Uno.'), controller.signal)) out.push(f);
    return out;
  })();

  await tick(10);
  socket.open();
  controller.abort();
  assert.deepEqual(await pump, [], 'no audio should survive the abort');
});

test('a server error rejects instead of hanging silently', async () => {
  const socket = new FakeSocket();
  const voice = new CartesiaVoice(config, { connect: () => socket as never });

  const pump = (async () => {
    for await (const _ of voice.synthesize(sentences('Uno.'), new AbortController().signal)) {
      // drain
    }
  })();

  await tick(10);
  socket.open();
  await tick(10);
  socket.message({ type: 'error', message: 'Model sunsetted' });

  await assert.rejects(pump, /Model sunsetted/);
});

test('the API key never appears in a thrown error', async () => {
  const withKey = loadConfig({ CARTESIA_API_KEY: 'sk_car_supersecret' });
  const socket = new FakeSocket();
  const voice = new CartesiaVoice(withKey, { connect: () => socket as never });

  const pump = (async () => {
    for await (const _ of voice.synthesize(sentences('Uno.'), new AbortController().signal)) {
      // drain
    }
  })();
  await tick(10);
  socket.open();
  await tick(10);
  socket.message({ type: 'error', message: 'bad request' });

  await pump.then(
    () => assert.fail('should have rejected'),
    (err: Error) => assert.ok(!String(err.stack).includes('supersecret')),
  );
});

// --- beyond the plan ------------------------------------------------------

test('the key is redacted even when the server echoes the connection URL back', async () => {
  // Cartesia reports some failures by quoting the request. The URL carries the
  // key as a query parameter, so nothing from the wire may be trusted verbatim.
  const withKey = loadConfig({ CARTESIA_API_KEY: 'sk_car_supersecret' });
  const socket = new FakeSocket();
  const voice = new CartesiaVoice(withKey, { connect: () => socket as never });

  const pump = (async () => {
    for await (const _ of voice.synthesize(sentences('Uno.'), new AbortController().signal)) {
      // drain
    }
  })();
  await tick(10);
  socket.open();
  await tick(10);
  socket.message({
    type: 'error',
    message: 'bad request for wss://api.cartesia.ai/tts/websocket?api_key=sk_car_supersecret',
  });

  await pump.then(
    () => assert.fail('should have rejected'),
    (err: Error) => {
      assert.ok(!err.message.includes('supersecret'), err.message);
      assert.ok(!String(err.stack).includes('supersecret'));
    },
  );
});

test('asks for raw 24 kHz PCM16, the rate the audio device runs at', async () => {
  // Spec §3: the unit runs at 24 kHz on both scopes so TTS audio reaches the
  // speaker with zero resampling.
  const socket = new FakeSocket();
  const voice = new CartesiaVoice(config, { connect: () => socket as never });

  const pump = (async () => {
    for await (const _ of voice.synthesize(sentences('Uno.'), new AbortController().signal)) {
      // drain
    }
  })();
  await tick(10);
  socket.open();
  await tick(10);

  const first = JSON.parse(socket.sent[0]!);
  assert.deepEqual(first.output_format, {
    container: 'raw',
    encoding: 'pcm_s16le',
    sample_rate: 24000,
  });
  assert.equal(first.model_id, config.voice.model);
  assert.equal(first.language, config.voice.language);
  assert.deepEqual(first.voice, { mode: 'id', id: config.voice.voiceId });

  socket.message({ type: 'done' });
  await pump;
});

test('a signal already aborted never opens a connection', async () => {
  let connections = 0;
  const voice = new CartesiaVoice(config, {
    connect: () => {
      connections += 1;
      return new FakeSocket() as never;
    },
  });
  const controller = new AbortController();
  controller.abort();

  const out: Int16Array[] = [];
  for await (const f of voice.synthesize(sentences('Uno.'), controller.signal)) out.push(f);

  assert.equal(connections, 0, 'nothing to synthesize, nothing to pay for');
  assert.deepEqual(out, []);
});

test('a malformed frame from the server fails the stream rather than crashing', async () => {
  const socket = new FakeSocket();
  const voice = new CartesiaVoice(config, { connect: () => socket as never });

  const pump = (async () => {
    for await (const _ of voice.synthesize(sentences('Uno.'), new AbortController().signal)) {
      // drain
    }
  })();
  await tick(10);
  socket.open();
  await tick(10);
  socket.raw('this is not json');

  await assert.rejects(pump, /Cartesia/);
});

test('a socket that errors while being torn down by an abort is not an error', async () => {
  // Found against the live service: undici fires `error` from inside close(),
  // so the barge-in path reported "connection failed" for every successful
  // interruption. A deliberate abort must resolve, never reject.
  const socket = new FakeSocket();
  socket.errorOnClose = true;
  const voice = new CartesiaVoice(config, { connect: () => socket as never });
  const controller = new AbortController();

  const pump = (async () => {
    const out: Int16Array[] = [];
    for await (const f of voice.synthesize(sentences('Uno.'), controller.signal)) out.push(f);
    return out;
  })();

  await tick(10);
  socket.open();
  await tick(10);
  controller.abort();
  assert.deepEqual(await pump, []);
});

test('prewarm pays for the handshake before the turn, and renews itself', async () => {
  // Measured: the handshake costs 458-500 ms and does not amortise across
  // connections, against a 1300 ms end-to-end budget (spec §4).
  const sockets: FakeSocket[] = [];
  const voice = new CartesiaVoice(config, {
    connect: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s as never;
    },
  });

  voice.prewarm();
  assert.equal(sockets.length, 1, 'the connection is opened ahead of the turn');
  sockets[0]!.open();

  const pump = (async () => {
    for await (const _ of voice.synthesize(sentences('Uno.'), new AbortController().signal)) {
      // drain
    }
  })();
  await tick(10);

  assert.ok(sockets[0]!.sent.length > 0, 'the turn reused the prewarmed socket');
  assert.equal(sockets.length, 2, 'and the next one is already being opened');

  sockets[0]!.message({ type: 'done' });
  await pump;

  voice.close();
  assert.ok(sockets[1]!.closed, 'close() releases the spare');
});

test('a dead spare is discarded rather than used', async () => {
  const sockets: FakeSocket[] = [];
  const voice = new CartesiaVoice(config, {
    connect: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s as never;
    },
  });

  voice.prewarm();
  sockets[0]!.open();
  sockets[0]!.close();

  const pump = (async () => {
    for await (const _ of voice.synthesize(sentences('Uno.'), new AbortController().signal)) {
      // drain
    }
  })();
  await tick(10);
  // One dead, one opened for this turn, one prewarmed for the next. The third
  // is the point: without it a single dropped spare makes every later turn pay
  // the 458-500ms handshake again, silently.
  assert.equal(sockets.length, 3, 'a fresh spare must replace the dead one');
  const fresh = sockets[1]!;
  fresh.open();
  await tick(10);
  assert.ok(fresh.sent.length > 0, 'the turn used a fresh connection');

  fresh.message({ type: 'done' });
  await pump;
  voice.close();
});

test('a connection that closes before done reports it instead of going quiet', async () => {
  // Spec §9: a voice agent that stops responding looks exactly like one that is
  // thinking, so a dropped stream must surface as an error the Director can act on.
  const socket = new FakeSocket();
  const voice = new CartesiaVoice(config, { connect: () => socket as never });

  const pump = (async () => {
    for await (const _ of voice.synthesize(sentences('Uno.'), new AbortController().signal)) {
      // drain
    }
  })();
  await tick(10);
  socket.open();
  await tick(10);
  socket.close();

  await assert.rejects(pump, /closed/i);
});
