import { describe, it, expect, vi } from 'vitest';
import { GeminiTtsClient, pcmToWav, type GeminiTtsOptions } from '@context/shared/infrastructure/gemini-tts-client';
import { TtsDailyQuotaError } from '@context/shared/domain/tts-client';

const KEY = 'AIza-test-secret';
const WAV = pcmToWav(Buffer.from([1, 0, 2, 0]));
const MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x44]);
const req = { text: 'hola mundo', voice: 'Kore', model: 'gemini-3.8-flash-tts', format: 'mp3' as const };

const audioResponse = (data = WAV, mimeType = 'audio/wav') => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ inlineData: { mimeType, data: data.toString('base64') } }] }, finishReason: 'STOP' }],
}), { status: 200 });
const errorResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const quota429 = (metric: string, retryDelay = '7s') => errorResponse(429, {
  error: {
    code: 429, status: 'RESOURCE_EXHAUSTED',
    message: `You exceeded your current quota. Quota exceeded for metric: generativelanguage.googleapis.com/${metric}`,
    details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }],
  },
});

function makeClient(fetchImpl: ReturnType<typeof vi.fn>, options: GeminiTtsOptions = {}, key = KEY) {
  const convert = vi.fn().mockResolvedValue(MP3);
  const sleep = vi.fn().mockResolvedValue(undefined);
  const client = new GeminiTtsClient(() => key, convert, { fetchImpl: fetchImpl as unknown as typeof fetch, sleep, ...options });
  return { client, convert, sleep };
}

describe('GeminiTtsClient', () => {
  it('reports configuration from the key and refuses to run without one', async () => {
    const { client } = makeClient(vi.fn(), {}, '');
    expect(client.isConfigured()).toBe(false);
    await expect(client.synthesize(req)).rejects.toThrow(/not configured/);
  });

  it('sends a correctly-shaped request and converts the WAV to MP3', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(audioResponse());
    const { client, convert } = makeClient(fetchImpl);

    const out = await client.synthesize(req);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent');
    expect(init.method).toBe('POST');
    expect(init.headers['x-goog-api-key']).toBe(KEY);
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'hola mundo' }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { voice: 'Kore' } } },
    });
    expect(String(url)).not.toContain(KEY);
    expect(convert).toHaveBeenCalledWith(WAV);
    expect(out.equals(MP3)).toBe(true);
  });

  it('sends instructions as speech_metadata.style only when set', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => audioResponse());
    const { client } = makeClient(fetchImpl);
    await client.synthesize({ ...req, instructions: '  calm tutor  ' });
    await client.synthesize({ ...req, instructions: '   ' });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).contents[0].parts[0]).toEqual({ text: 'hola mundo', speech_metadata: { style: 'calm tutor' } });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).contents[0].parts[0]).toEqual({ text: 'hola mundo' });
  });

  it('wraps raw PCM (audio/L16) in a WAV header before converting', async () => {
    const pcm = Buffer.from([5, 0, 6, 0]);
    const { client, convert } = makeClient(vi.fn().mockResolvedValue(audioResponse(pcm, 'audio/L16;codec=pcm;rate=24000')));
    await client.synthesize(req);
    expect(convert.mock.calls[0][0].equals(pcmToWav(pcm, 24000))).toBe(true);
  });

  it('rejects non-mp3 formats', async () => {
    const { client } = makeClient(vi.fn());
    await expect(client.synthesize({ ...req, format: 'wav' })).rejects.toThrow(/only produces mp3/);
  });

  it('fails clearly on malformed or empty responses', async () => {
    const noAudio = new Response(JSON.stringify({ candidates: [{ finishReason: 'SAFETY' }] }), { status: 200 });
    await expect(makeClient(vi.fn().mockResolvedValue(noAudio)).client.synthesize(req)).rejects.toThrow(/no audio \(finishReason=SAFETY\)/);
    await expect(makeClient(vi.fn().mockResolvedValue(new Response('<html>', { status: 200 }))).client.synthesize(req)).rejects.toThrow(/non-JSON/);
    await expect(makeClient(vi.fn().mockResolvedValue(audioResponse(Buffer.alloc(0)))).client.synthesize(req)).rejects.toThrow(/no audio|empty audio/);
    await expect(makeClient(vi.fn().mockResolvedValue(audioResponse(Buffer.from('xyz'), 'audio/ogg'))).client.synthesize(req)).rejects.toThrow(/unexpected audio type/);
  });

  it('surfaces converter failures', async () => {
    const { client, convert } = makeClient(vi.fn().mockResolvedValue(audioResponse()));
    convert.mockRejectedValueOnce(new Error('ffmpeg could not run (ffmpeg): spawn ffmpeg ENOENT'));
    await expect(client.synthesize(req)).rejects.toThrow(/ffmpeg could not run/);
  });

  it('retries a 429 after the server-provided delay, then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(quota429('generate_requests_per_model', '7s'))
      .mockResolvedValueOnce(audioResponse());
    const { client, sleep } = makeClient(fetchImpl, { maxTotalMs: 60_000 });
    const out = await client.synthesize(req);
    expect(out.equals(MP3)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  it('honours a Retry-After header', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(errorResponse(429, 'slow down', { 'retry-after': '2' }))
      .mockResolvedValueOnce(audioResponse());
    const { client, sleep } = makeClient(fetchImpl);
    await client.synthesize(req);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('retries 5xx with exponential backoff', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(errorResponse(503, 'unavailable'))
      .mockResolvedValueOnce(errorResponse(500, 'internal'))
      .mockResolvedValueOnce(audioResponse());
    const { client, sleep } = makeClient(fetchImpl);
    await client.synthesize(req);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[1000], [2000]]);
  });

  it('gives up after maxAttempts', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => errorResponse(503, 'unavailable'));
    const { client, sleep } = makeClient(fetchImpl, { maxAttempts: 3 });
    await expect(client.synthesize(req)).rejects.toThrow(/503.*gave up after 3 attempts/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not wait past the total time budget', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(quota429('generate_requests_per_model', '45s'));
    const { client, sleep } = makeClient(fetchImpl, { maxTotalMs: 30_000 });
    await expect(client.synthesize(req)).rejects.toThrow(/429.*gave up after 1 attempt\)/);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry an exhausted per-day quota and throws a typed error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(quota429('generate_requests_per_model_per_day'));
    const { client, sleep } = makeClient(fetchImpl);
    const error = await client.synthesize(req).catch(e => e);
    expect(error).toBeInstanceOf(TtsDailyQuotaError);
    expect(error.code).toBe('TTS_DAILY_QUOTA');
    expect(error.message).toMatch(/429/);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry other 4xx errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(400, 'bad voice'));
    const { client } = makeClient(fetchImpl);
    await expect(client.synthesize(req)).rejects.toThrow(/400.*bad voice/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('times out a hanging request', async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    }));
    const { client } = makeClient(fetchImpl, { timeoutMs: 20 });
    await expect(client.synthesize(req)).rejects.toThrow(/timed out after 0.02 s/);
  });

  it('redacts the API key echoed in an upstream error or a network failure', async () => {
    const echoed = makeClient(vi.fn().mockResolvedValue(errorResponse(403, `API key ${KEY} is not valid`)));
    const e1 = await echoed.client.synthesize(req).catch(e => e);
    expect(e1.message).toContain('[REDACTED]');
    expect(e1.message).not.toContain(KEY);

    const network = makeClient(vi.fn().mockRejectedValue(new TypeError(`fetch failed for key=${KEY}`)));
    const e2 = await network.client.synthesize(req).catch(e => e);
    expect(e2.message).not.toContain(KEY);

    const quota = makeClient(vi.fn().mockResolvedValue(errorResponse(429, `per_day quota for ${KEY}`)));
    const e3 = await quota.client.synthesize(req).catch(e => e);
    expect(e3).toBeInstanceOf(TtsDailyQuotaError);
    expect(e3.message).not.toContain(KEY);
  });
});
