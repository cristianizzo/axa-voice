import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { access } from 'node:fs/promises';
import type { Config } from '../config.ts';

const VAD_MODEL_URL =
  'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin';

async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
      .on('connect', () => { socket.destroy(); resolve(false); })
      .on('error', () => resolve(true));
  });
}

export async function preflight(config: Config): Promise<void> {
  const { modelPath, vadModelPath, port } = config.stt;

  await access(modelPath).catch(() => {
    throw new Error(
      `whisper model not found at ${modelPath}. Download ggml-small.bin from ` +
        'https://huggingface.co/ggerganov/whisper.cpp',
    );
  });

  await access(vadModelPath).catch(() => {
    throw new Error(
      `Silero VAD model not found at ${vadModelPath}. Download it (885 KB) from ` +
        `${VAD_MODEL_URL}\nRefusing to start without it: without VAD, whisper turns ` +
        'silence into confident sentences and the agent answers questions nobody asked.',
    );
  });

  if (!(await portIsFree(port))) {
    throw new Error(
      `port ${port} is already in use. macOS lets a second whisper-server bind the ` +
        'same port and then splits requests between them, so transcripts come from an ' +
        'unpredictable model. Stop the other process before starting.',
    );
  }
}

export class WhisperServer {
  readonly url: string;
  readonly #config: Config;
  #proc: ChildProcess | undefined;

  constructor(config: Config) {
    this.#config = config;
    this.url = `http://127.0.0.1:${config.stt.port}`;
  }

  async start(): Promise<void> {
    await preflight(this.#config);
    const { port, modelPath, vadModelPath, language } = this.#config.stt;

    this.#proc = spawn(
      'whisper-server',
      [
        '-m', modelPath,
        '--port', String(port),
        '--host', '127.0.0.1',
        '-l', language,
        '--vad',
        '--vad-model', vadModelPath,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    const deadline = Date.now() + 20_000;
    for (;;) {
      if (Date.now() > deadline) {
        await this.stop();
        throw new Error('whisper-server did not become healthy within 20s');
      }
      try {
        const res = await fetch(`${this.url}/health`);
        if (res.ok) return;
      } catch {
        // Not up yet. The loop's deadline is the only exit.
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async stop(): Promise<void> {
    const proc = this.#proc;
    if (!proc) return;
    this.#proc = undefined;
    proc.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 2000);
      proc.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}
