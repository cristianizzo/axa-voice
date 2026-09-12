import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../../src/config.ts';
import { WhisperServer } from '../../src/stt/server.ts';
import { WhisperTranscriber } from '../../src/stt/transcriber.ts';
import { VadTurnDetector } from '../../src/turn/detector.ts';
import { ClaudeAgentSession } from '../../src/agent/session.ts';
import { CartesiaVoice } from '../../src/voice/cartesia.ts';
import { SentenceSpeechFilter } from '../../src/filter/speech-filter.ts';
import { Director } from '../../src/director/director.ts';
import type { AudioFrame, AudioInput, AudioOutput, Unsubscribe } from '../../src/types.ts';

/**
 * End-to-end latency on the real pipeline: real whisper, real Claude, real
 * Cartesia. Only the two ends are replaced — a WAV reader instead of the
 * microphone, a recorder instead of the speakers — because everything in
 * between is what the 1300ms budget is spent on (spec §4).
 */

const FIXTURE = new URL('../fixtures/utterance.wav', import.meta.url);
const BUDGET_MS = 1300;
const TURNS = 4;
const TURN_DEADLINE_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read the `data` chunk of a 16-bit mono WAV. The header is not a fixed 44 bytes. */
function readWav(url: URL): Int16Array {
  const buffer = readFileSync(url);
  let offset = 12; // past "RIFF<size>WAVE"
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'data') {
      const samples = new Int16Array(size / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = buffer.readInt16LE(offset + 8 + i * 2);
      return samples;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('no data chunk in the fixture');
}

function toFrames(samples: Int16Array, frameSamples: number): Int16Array[] {
  const frames: Int16Array[] = [];
  for (let at = 0; at + frameSamples <= samples.length; at += frameSamples) {
    frames.push(samples.slice(at, at + frameSamples));
  }
  return frames;
}

/** An AudioInput the test pumps by hand, one frame at a time. */
class ManualInput implements AudioInput {
  readonly #frameHandlers = new Set<(frame: AudioFrame) => void>();
  readonly #errorHandlers = new Set<(message: string) => void>();

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  onFrame(cb: (frame: AudioFrame) => void): Unsubscribe {
    this.#frameHandlers.add(cb);
    return () => this.#frameHandlers.delete(cb);
  }

  onError(cb: (message: string) => void): Unsubscribe {
    this.#errorHandlers.add(cb);
    return () => this.#errorHandlers.delete(cb);
  }

  emit(frame: AudioFrame): void {
    for (const handler of this.#frameHandlers) handler(frame);
  }
}

class Recorder implements AudioOutput {
  firstFrameAt: number | undefined;
  frames = 0;

  enqueue(_frame: AudioFrame): void {
    this.firstFrameAt ??= performance.now();
    this.frames++;
  }

  async flush(): Promise<{ heardMs: number }> {
    return { heardMs: 0 };
  }

  isPlaying(): boolean {
    return false;
  }

  reset(): void {
    this.firstFrameAt = undefined;
    this.frames = 0;
  }
}

test(
  'first audio within 1300ms on a warm session',
  {
    skip: process.env.AXA_LIVE ? false : 'set AXA_LIVE=1 to spend money on a real session',
    timeout: 300_000,
  },
  async () => {
    const config = loadConfig(process.env);
    const speech = toFrames(readWav(FIXTURE), config.audio.frameSamples);
    const silence = new Int16Array(config.audio.frameSamples);
    const cadenceMs = (config.audio.frameSamples / config.audio.frameRate) * 1000;

    const audioIn = new ManualInput();
    const audioOut = new Recorder();
    const whisper = new WhisperServer(config);
    const agent = new ClaudeAgentSession(config);
    const voice = new CartesiaVoice(config);

    const director = new Director({
      config,
      audioIn,
      audioOut,
      transcriber: new WhisperTranscriber(config),
      turns: new VadTurnDetector(config),
      agent,
      voice,
      filter: new SentenceSpeechFilter(),
      onError: (message) => console.error(`[audio] ${message}`),
    });

    await whisper.start();
    await agent.start();
    await director.start();

    const samples: number[] = [];
    try {
      for (let turn = 0; turn < TURNS; turn++) {
        audioOut.reset();

        // Real cadence, because the turn detector and whisper's partial loop
        // both measure real time. Feeding faster would measure a pipeline that
        // does not exist.
        for (const frame of speech) {
          audioIn.emit(frame);
          await sleep(cadenceMs);
        }
        const spokeUntil = performance.now();

        const deadline = spokeUntil + TURN_DEADLINE_MS;
        while (audioOut.firstFrameAt === undefined && performance.now() < deadline) {
          audioIn.emit(silence);
          await sleep(cadenceMs);
        }
        assert.ok(audioOut.firstFrameAt, `no audio came back within ${TURN_DEADLINE_MS}ms`);

        // Turn 1 pays process spawn, config load and system-prompt processing
        // and measures ~7s. Reporting it would send someone optimising
        // something that was never slow (spec §4).
        const measured = audioOut.firstFrameAt - spokeUntil;
        if (turn > 0) samples.push(measured);
        console.log(`turn ${turn}: ${measured.toFixed(0)}ms${turn === 0 ? ' (warm-up, discarded)' : ''}`);

        // Let the answer finish, so the next turn does not start as a barge-in.
        const idle = performance.now() + TURN_DEADLINE_MS;
        while (director.state !== 'LISTENING' && performance.now() < idle) {
          audioIn.emit(silence);
          await sleep(cadenceMs);
        }
      }
    } finally {
      await director.stop();
      await agent.close();
      await whisper.stop();
    }

    const sorted = samples.sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    console.log(`median: ${median.toFixed(0)}ms over ${sorted.length} turns`);
    assert.ok(median < BUDGET_MS, `median first audio was ${median.toFixed(0)}ms (budget ${BUDGET_MS}ms, spec §4)`);
  },
);
