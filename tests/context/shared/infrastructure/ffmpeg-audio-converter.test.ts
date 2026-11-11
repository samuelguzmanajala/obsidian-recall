import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { assertFfmpegUsable, ffmpegWavToMp3 } from '@context/shared/infrastructure/ffmpeg-audio-converter';
import { pcmToWav } from '@context/shared/infrastructure/gemini-tts-client';

const FFMPEG = process.env.RECALL_FFMPEG
  || ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find(p => existsSync(p))
  || 'ffmpeg';
const hasFfmpeg = !spawnSync(FFMPEG, ['-version']).error;

/** 0.5 s of a 440 Hz sine, 24 kHz mono 16-bit, like Gemini returns. */
function sineWav(): Buffer {
  const rate = 24000;
  const pcm = Buffer.alloc(rate);
  for (let i = 0; i < rate / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 12000), i * 2);
  return pcmToWav(pcm, rate);
}

describe('ffmpeg converter', () => {
  it('reports a missing ffmpeg clearly', async () => {
    expect(() => assertFfmpegUsable('/nonexistent/ffmpeg')).toThrow(/cannot be run.*RECALL_FFMPEG/);
    await expect(ffmpegWavToMp3('/nonexistent/ffmpeg')(sineWav())).rejects.toThrow(/ffmpeg could not run/);
  });

  it.skipIf(!hasFfmpeg)('converts a WAV into MP3 with a real ffmpeg', async () => {
    expect(() => assertFfmpegUsable(FFMPEG)).not.toThrow();
    const mp3 = await ffmpegWavToMp3(FFMPEG)(sineWav());
    // An MP3 frame header (sync word 0xFFE) — possibly after an ID3 tag.
    const start = mp3.toString('latin1', 0, 3) === 'ID3' ? 10 + ((mp3[6] << 21) | (mp3[7] << 14) | (mp3[8] << 7) | mp3[9]) : 0;
    expect(mp3[start]).toBe(0xff);
    expect(mp3[start + 1] & 0xe0).toBe(0xe0);
  });

  it.skipIf(!hasFfmpeg)('rejects input that is not audio', async () => {
    await expect(ffmpegWavToMp3(FFMPEG)(Buffer.from('not a wav'))).rejects.toThrow(/ffmpeg failed/);
  });
});
