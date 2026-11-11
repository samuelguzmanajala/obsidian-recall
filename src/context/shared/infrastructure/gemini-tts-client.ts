import { TtsClient, TtsDailyQuotaError, TtsRequest } from '../domain/tts-client';
import type { WavToMp3 } from './ffmpeg-audio-converter';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.8-flash-tts';

export interface GeminiTtsOptions {
  fetchImpl?: typeof fetch;
  /** Per-attempt HTTP timeout. */
  timeoutMs?: number;
  /** Attempts in total (first call included). */
  maxAttempts?: number;
  /** Budget for the whole call, retries and waits included; no retry starts past it. */
  maxTotalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Gemini TTS via generateContent. The API only returns WAV/PCM, so audio is
 * converted to MP3 by the injected converter (the clients only play MP3).
 * Defaults suit the on-demand HTTP route: the phone gives up after ~45 s.
 */
export class GeminiTtsClient implements TtsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly maxTotalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly getApiKey: () => string, private readonly convert: WavToMp3, options: GeminiTtsOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.maxTotalMs = options.maxTotalMs ?? 30_000;
    this.sleep = options.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.now = options.now ?? Date.now;
  }

  isConfigured(): boolean {
    return this.getApiKey().trim().length > 0;
  }

  async synthesize(req: TtsRequest): Promise<Buffer> {
    const key = this.getApiKey().trim();
    if (!key) throw new Error('Gemini TTS API key not configured.');
    if (req.format !== 'mp3') throw new Error(`Gemini TTS only produces mp3 here, not ${req.format}`);
    const redact = (s: string) => s.split(key).join('[REDACTED]');
    const model = req.model ?? DEFAULT_MODEL;
    const part: Record<string, unknown> = { text: req.text };
    // Gemini 3.8 reads `text` verbatim; style is optional turn-level steering.
    if (req.instructions?.trim()) part.speech_metadata = { style: req.instructions.trim() };
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [part] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { voice: req.voice } } },
    });
    const url = `${BASE_URL}/${encodeURIComponent(model)}:generateContent`;
    const deadline = this.now() + this.maxTotalMs;

    for (let attempt = 1; ; attempt++) {
      const timeout = Math.max(1, Math.min(this.timeoutMs, deadline - this.now()));
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body,
          signal: AbortSignal.timeout(timeout),
        });
      } catch (error) {
        if ((error as Error)?.name === 'TimeoutError') throw new Error(`Gemini TTS request timed out after ${timeout / 1000} s`);
        throw new Error(`Gemini TTS request failed: ${redact(String((error as Error)?.message ?? error))}`);
      }
      if (res.ok) return this.convert(await this.wavFrom(res, redact));

      const text = redact(await res.text().catch(() => ''));
      const message = `Gemini TTS error (${res.status}): ${text.slice(0, 300)}`;
      // Per-day quota: no point in retrying until tomorrow.
      if (res.status === 429 && /per_?day/i.test(text)) throw new TtsDailyQuotaError(message);
      if (res.status !== 429 && res.status < 500) throw new Error(message);
      const delay = retryDelayMs(res, text) ?? 1000 * 2 ** (attempt - 1);
      if (attempt >= this.maxAttempts || this.now() + delay >= deadline) {
        throw new Error(`${message} (gave up after ${attempt} attempt${attempt > 1 ? 's' : ''})`);
      }
      await this.sleep(delay);
    }
  }

  private async wavFrom(res: Response, redact: (s: string) => string): Promise<Buffer> {
    let json: any;
    try { json = await res.json(); } catch { throw new Error('Gemini TTS returned a non-JSON response'); }
    const candidate = json?.candidates?.[0];
    const inline = candidate?.content?.parts?.find((p: any) => p?.inlineData?.data)?.inlineData;
    if (!inline) {
      throw new Error(`Gemini TTS returned no audio (finishReason=${candidate?.finishReason ?? 'none'}): ${redact(JSON.stringify(json ?? null)).slice(0, 200)}`);
    }
    const audio = Buffer.from(String(inline.data), 'base64');
    if (audio.length === 0) throw new Error('Gemini TTS returned empty audio');
    const mime = String(inline.mimeType ?? '').toLowerCase();
    if (audio.toString('latin1', 0, 4) === 'RIFF') return audio;
    if (mime.startsWith('audio/l16') || mime.startsWith('audio/pcm')) return pcmToWav(audio, Number(/rate=(\d+)/.exec(mime)?.[1] ?? 24000));
    throw new Error(`Gemini TTS returned unexpected audio type "${mime}"`);
  }
}

/** Server-provided delay: Retry-After header, RetryInfo.retryDelay, or "retry in Ns" text. 0 means "use backoff". */
function retryDelayMs(res: Response, body: string): number | undefined {
  const header = Number(res.headers?.get?.('retry-after'));
  if (header > 0) return header * 1000;
  let seconds: number | undefined;
  try {
    const details = JSON.parse(body)?.error?.details;
    const info = Array.isArray(details) ? details.find((d: any) => String(d?.['@type']).includes('RetryInfo')) : undefined;
    if (info?.retryDelay) seconds = parseFloat(info.retryDelay);
  } catch { /* not JSON */ }
  seconds ??= parseFloat(/retry in ([\d.]+)\s*s/i.exec(body)?.[1] ?? '');
  return seconds > 0 ? Math.ceil(seconds * 1000) : undefined;
}

/** Wraps raw 16-bit little-endian mono PCM in a WAV header. */
export function pcmToWav(pcm: Buffer, sampleRate = 24000): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
