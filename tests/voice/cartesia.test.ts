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
  close(code?: number, reason?: string) {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    if (this.errorOnClose) this.dispatchEvent(new Event('error'));
    this.dispatchEvent(Object.assign(new Event('close'), { code: code ?? 1000, reason: reason ?? '' }));
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

test('asks for raw PCM16 at config.audio.deviceRate, the rate the audio device runs at', async () => {
  // Spec §3: the unit runs at the same rate on both scopes so TTS audio
  // reaches the speaker with zero resampling. sample_rate must therefore
  // track config.audio.deviceRate, not a hardcoded literal.
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
    sample_rate: config.audio.deviceRate,
  });
  assert.equal(first.model_id, config.voice.model);
  assert.equal(first.language, config.voice.language);
  assert.deepEqual(first.voice, { mode: 'id', id: config.voice.voiceId });

  socket.message({ type: 'done' });
  await pump;
});

test('an explicit language override wins over config.voice.language', async () => {
  // Director tracks a live mid-conversation language switch and passes it in
  // per call (spec: 2026-09-27) — CartesiaVoice itself stays stateless and
  // must not need to be reconstructed to speak a different language.
  const socket = new FakeSocket();
  const voice = new CartesiaVoice(config, { connect: () => socket as never });

  const pump = (async () => {
    for await (const _ of voice.synthesize(sentences('Hello.'), new AbortController().signal, 'en')) {
      // drain
    }
  })();
  await tick(10);
  socket.open();
  await tick(10);

  const first = JSON.parse(socket.sent[0]!);
  assert.equal(first.language, 'en', 'the per-call override must win over config.voice.language');
  assert.notEqual('en', config.voice.language, 'sanity: the override must actually differ from the config default');

  socket.message({ type: 'done' });
  await pump;
});

test('omitting the language override falls back to config.voice.language as before', async () => {
  const socket = new FakeSocket();
  const voice = new CartesiaVoice(config, { connect: () => socket as never });

  const pump = (async () => {
    for await (const _ of voice.synthesize(sentences('Ciao.'), new AbortController().signal)) {
      // drain
    }
  })();
  await tick(10);
  socket.open();
  await tick(10);

  const first = JSON.parse(socket.sent[0]!);
  assert.equal(first.language, config.voice.language);

  socket.message({ type: 'done' });
  await pump;
});

test('sample_rate follows config.audio.deviceRate, not a hardcoded literal', async () => {
  // Proves the value is wired from config rather than baked in: a config with
  // a different deviceRate must produce a different outgoing sample_rate.
  const custom = loadConfig({ CARTESIA_API_KEY: 'sk_test' }) as unknown as {
    audio: { deviceRate: number };
  };
  Object.assign(custom.audio, { deviceRate: 8000 });

  const socket = new FakeSocket();
  const voice = new CartesiaVoice(custom as never, { connect: () => socket as never });

  const pump = (async () => {
    for await (const _ of voice.synthesize(sentences('Uno.'), new AbortController().signal)) {
      // drain
    }
  })();
  await tick(10);
  socket.open();
  await tick(10);

  const first = JSON.parse(socket.sent[0]!);
  assert.equal(first.output_format.sample_rate, 8000);

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

test('a handshake that never opens, closes, nor errors fails after the connect timeout', async () => {
  // Found against the live service: an account/credits/auth rejection that
  // never completes a clean WS close used to hang the whole turn silently
  // until the unrelated 45s turn-timeout in director.ts called abort().
  const socket = new FakeSocket();
  const voice = new CartesiaVoice(config, { connect: () => socket as never, connectTimeoutMs: 15 });

  const pump = (async () => {
    for await (const _ of voice.synthesize(sentences('Uno.'), new AbortController().signal)) {
      // drain
    }
  })();

  // The connect-timeout timer is deliberately unref'd (so it never by itself
  // keeps a real CLI process alive). In production something else — mic
  // capture, the event loop of the running app — always keeps Node alive
  // regardless; here nothing else does, so this stands in for that.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    // Deliberately never call socket.open()/close()/error — the socket just
    // sits there, exactly like the hung handshake found in production.
    await assert.rejects(pump, /no response from the server/i);
  } finally {
    clearInterval(keepAlive);
  }
});

test('a close with a code and reason before the socket ever opens surfaces both', async () => {
  const socket = new FakeSocket();
  const voice = new CartesiaVoice(config, { connect: () => socket as never });

  const pump = (async () => {
    for await (const _ of voice.synthesize(sentences('Uno.'), new AbortController().signal)) {
      // drain
    }
  })();

  await tick(10);
  socket.close(4001, 'unauthorized');

  await pump.then(
    () => assert.fail('should have rejected'),
    (err: Error) => {
      assert.match(err.message, /code 4001/);
      assert.match(err.message, /unauthorized/);
      assert.match(err.message, /possibly out of credits or an invalid API key/i);
    },
  );
});

test('a connect timeout rejects promptly even when the next sentence never arrives', async () => {
  // Found in review of the connect-timeout patch: `feeding` awaits
  // `text.next()`, fed incrementally by the director as the model keeps
  // generating. If that never resolves, `await feeding` after the main loop
  // used to block forever even though the connect timeout had already fired
  // and set `done = true` — the turn hung at a different line instead of
  // being fixed. `stalledText` below never yields, simulating exactly that.
  const socket = new FakeSocket();
  const connectTimeoutMs = 15;
  const voice = new CartesiaVoice(config, { connect: () => socket as never, connectTimeoutMs });

  const stalledText = (async function* () {
    // eslint-disable-next-line no-constant-condition
    await new Promise<void>(() => {
      /* never resolves: the director never produces the next sentence */
    });
    yield 'unreachable';
  })();

  const started = Date.now();
  const pump = (async () => {
    for await (const _ of voice.synthesize(stalledText, new AbortController().signal)) {
      // drain
    }
  })();

  // See the note in the previous test: the connect-timeout timer is unref'd
  // by design, so this stands in for the "something else keeps Node alive"
  // that is always true of the real CLI.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    // Deliberately never call socket.open()/close()/error, just like the
    // existing connect-timeout test — the socket just sits there.
    await assert.rejects(pump, /no response from the server/i);
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed < connectTimeoutMs + 500,
      `expected synthesize() to reject within ~${connectTimeoutMs}ms of the connect timeout, took ${elapsed}ms`,
    );
  } finally {
    clearInterval(keepAlive);
  }
});

test('aborting while still connecting is a clean no-op, not a thrown error', async () => {
  const socket = new FakeSocket();
  const voice = new CartesiaVoice(config, { connect: () => socket as never });
  const controller = new AbortController();

  const pump = (async () => {
    const out: Int16Array[] = [];
    for await (const f of voice.synthesize(sentences('Uno.'), controller.signal)) out.push(f);
    return out;
  })();

  await tick(10);
  // Never opened: the socket is still mid-handshake when the barge-in lands.
  controller.abort();

  assert.deepEqual(await pump, [], 'a real user interrupt while connecting must not throw');
});
