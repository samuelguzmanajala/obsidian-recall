import { spawn, spawnSync } from 'node:child_process';

/** Converts a WAV buffer into MP3 bytes. */
export type WavToMp3 = (wav: Buffer) => Promise<Buffer>;

/** Mono, libmp3lame, VBR quality 4 (what the voice listening test used). */
const ARGS = ['-hide_banner', '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0',
  '-ac', '1', '-c:a', 'libmp3lame', '-q:a', '4', '-f', 'mp3', 'pipe:1'];

/** Pipes through ffmpeg over stdin/stdout: no shell, no temp files. */
export function ffmpegWavToMp3(ffmpegPath = 'ffmpeg', timeoutMs = 30_000): WavToMp3 {
  return wav => new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ARGS, { stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => { if (err.length < 2000) err += d.toString(); });
    child.on('error', e => reject(new Error(`ffmpeg could not run (${ffmpegPath}): ${e.message}`)));
    child.on('close', (code, signal) => {
      const mp3 = Buffer.concat(out);
      if (code === 0 && mp3.length > 0) resolve(mp3);
      else reject(new Error(`ffmpeg failed (${signal ?? `exit ${code}`}): ${err.trim().slice(0, 300) || 'no output'}`));
    });
    child.stdin.on('error', () => { /* reported through close */ });
    child.stdin.end(wav);
  });
}

/** Fails fast when ffmpeg is missing or lacks the MP3 encoder. */
export function assertFfmpegUsable(ffmpegPath = 'ffmpeg'): void {
  const r = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000 });
  if (r.error || r.status !== 0) {
    throw new Error(`ffmpeg is required for RECALL_TTS_PROVIDER=gemini but "${ffmpegPath}" cannot be run`
      + ` (${r.error?.message ?? `exit ${r.status}`}). Install ffmpeg or set RECALL_FFMPEG to its absolute path.`);
  }
  if (!r.stdout.includes('libmp3lame')) throw new Error(`ffmpeg at "${ffmpegPath}" has no libmp3lame encoder`);
}
