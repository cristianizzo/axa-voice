import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig } from '../../src/config.ts';
import { AudioDevice } from '../../src/audio/device.ts';
import { WhisperServer } from '../../src/stt/server.ts';
import { WhisperTranscriber } from '../../src/stt/transcriber.ts';
import { VadTurnDetector } from '../../src/turn/detector.ts';
import type { AudioFrame } from '../../src/types.ts';

/**
 * The one thing that cannot be tested with a fake: whether the echo canceller
 * actually works in a room. The speakers play real speech, the microphone is
 * open the whole time, and the question is whether anything of the agent's own
 * voice survives into the transcript.
 *
 * Without AEC this fails loudly and correctly: the mic hears the speakers, the
 * transcript fills with the agent's own words, and it interrupts itself in a
 * loop (spec §6). Headphones would hide the bug, which is exactly why the
 * requirement is open speakers.
 */

const FIXTURE = new URL('../fixtures/utterance.wav', import.meta.url);
const PLAYBACK_MS = 3000;
const FRAME_MS = 20;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function readWavData(url: URL): Int16Array {
  const buffer = readFileSync(url);
  let offset = 12;
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

/** Linear resample. The fixture is 16k; the speaker bus runs at 24k. */
function resample(samples: Int16Array, from: number, to: number): Int16Array {
  const ratio = from / to;
  const out = new Int16Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const at = i * ratio;
    const low = Math.floor(at);
    const high = Math.min(low + 1, samples.length - 1);
    out[i] = Math.round(samples[low]! + (samples[high]! - samples[low]!) * (at - low));
  }
  return out;
}

const config = loadConfig({ CARTESIA_API_KEY: 'sk_not_used_here' });
const canRun =
  process.platform === 'darwin' &&
  existsSync(config.audio.helperPath) &&
  !process.env.AXA_NO_AUDIO_HW &&
  Boolean(process.env.AXA_LIVE);

test(
  'the agent does not interrupt itself',
  {
    skip: canRun ? false : 'set AXA_LIVE=1 and run on a Mac with speakers and a microphone',
    timeout: 120_000,
  },
  async () => {
    // No real key: this test never speaks through the TTS. It plays the fixture
    // straight into the device, because the question is what the microphone
    // hears from the speakers, not what produced the sound.
    const device = new AudioDevice(config);
    const whisper = new WhisperServer(config);
    const turns = new VadTurnDetector(config);

    let selfInterrupts = 0;
    turns.onSpeechStart(() => {
      selfInterrupts++;
    });

    await whisper.start();
    await device.start();

    const stream = await new WhisperTranscriber(config).open();
    let transcript = '';
    stream.onFinal((text) => {
      transcript = text;
    });

    // The mic is open for the whole playback, exactly as it is during a real
    // answer. Every frame goes to both the detector and the transcriber.
    const off = device.onFrame((frame: AudioFrame) => {
      turns.push(frame, null);
      stream.push(frame);
    });

    try {
      const speech = resample(readWavData(FIXTURE), config.audio.frameRate, config.audio.deviceRate);
      const frameSamples = Math.round((config.audio.deviceRate * FRAME_MS) / 1000);

      const until = Date.now() + PLAYBACK_MS;
      while (Date.now() < until) {
        for (let at = 0; at + frameSamples <= speech.length && Date.now() < until; at += frameSamples) {
          device.enqueue(speech.slice(at, at + frameSamples));
          // Keep roughly one frame ahead: dumping 3s at once would let the
          // canceller see a reference signal no real turn ever produces.
          await sleep(FRAME_MS);
        }
      }
      while (device.isPlaying()) await sleep(FRAME_MS);
      // Let the tail of the room reverberation reach the microphone.
      await sleep(300);
    } finally {
      off();
      await stream.close();
      await device.stop();
      await whisper.stop();
    }

    assert.equal(selfInterrupts, 0, 'AEC is not suppressing the playback path');
    assert.equal(transcript.trim(), '', `the agent transcribed its own voice: "${transcript}"`);
  },
);
