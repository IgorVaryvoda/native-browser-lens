// Voice notes: the microphone in an extension page, a 16 kHz mono WAV, and an upload in chunks.
import type { LensClient } from '@/lens-client';
import type { BlobRef } from '@/protocol/BlobRef';

const SAMPLE_RATE = 16_000;
/** Raw bytes per upload request; base64 makes each request about 4 MiB, under the 16 MiB limit. */
const CHUNK_BYTES = 3 * 1024 * 1024;

export interface Recording {
  startedAt: number;
  stop(): Promise<Blob>;
  cancel(): void;
}

/** The microphone is refused here: a side panel cannot ask, so a tab must ask once. */
export class MicrophoneBlocked extends Error {}

export async function record(): Promise<Recording> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    if ((error as DOMException).name === 'NotAllowedError') throw new MicrophoneBlocked((error as Error).message);
    throw error;
  }
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
  recorder.start(1000);
  const release = () => stream.getTracks().forEach((track) => track.stop());
  return {
    startedAt: Date.now(),
    cancel: () => (recorder.state !== 'inactive' && recorder.stop(), release()),
    stop: () =>
      new Promise<Blob>((done, fail) => {
        recorder.onstop = () => {
          release();
          toWav(new Blob(chunks, { type: recorder.mimeType })).then(done, fail);
        };
        recorder.stop();
      }),
  };
}

/** Decodes what MediaRecorder wrote and resamples it to 16 kHz mono, as Whisper reads it. */
async function toWav(encoded: Blob): Promise<Blob> {
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    const audio = await context.decodeAudioData(await encoded.arrayBuffer());
    const mono = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const channel = audio.getChannelData(c);
      for (let i = 0; i < mono.length; i++) mono[i]! += channel[i]! / audio.numberOfChannels;
    }
    return encodeWav(mono);
  } finally {
    void context.close();
  }
}

export function encodeWav(samples: Float32Array): Blob {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}

/** Sends a file to the daemon in chunks; the last reply names the stored blob. */
export async function upload(client: LensClient, file: Blob, mediaType: 'audio/wav' | 'application/json'): Promise<BlobRef> {
  const id = crypto.randomUUID();
  for (let offset = 0; ; offset += CHUNK_BYTES) {
    const part = file.slice(offset, offset + CHUNK_BYTES);
    const done = offset + CHUNK_BYTES >= file.size;
    const stored = await client.request({
      method: 'uploadChunk',
      params: { upload: id, offset, data: await base64(part), done, mediaType },
    });
    if (done) {
      if (!stored) throw new Error('Lens did not store the upload');
      return stored;
    }
  }
}

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
