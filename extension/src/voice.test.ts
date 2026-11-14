import { describe, expect, it } from 'vitest';
import { encodeWav } from './voice';

describe('encodeWav', () => {
  it('writes the 16 kHz mono 16-bit header the daemon checks', async () => {
    const wav = new DataView(await encodeWav(new Float32Array([0, 1, -1, 0.5])).arrayBuffer());
    const text = (o: number) => String.fromCharCode(...[0, 1, 2, 3].map((i) => wav.getUint8(o + i)));
    expect([text(0), text(8), text(36)]).toEqual(['RIFF', 'WAVE', 'data']);
    expect([wav.getUint16(20, true), wav.getUint16(22, true), wav.getUint32(24, true), wav.getUint16(34, true)]).toEqual([1, 1, 16000, 16]);
    expect(wav.byteLength).toBe(44 + 8);
    expect([wav.getInt16(46, true), wav.getInt16(48, true)]).toEqual([0x7fff, -0x8000]);
  });
});
