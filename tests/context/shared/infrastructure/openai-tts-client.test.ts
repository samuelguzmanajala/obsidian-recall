import { describe, it, expect, vi } from 'vitest';
import { OpenAiTtsClient } from '@context/shared/infrastructure/openai-tts-client';

describe('OpenAiTtsClient', () => {
  const fakeAudio = Buffer.from([0xff, 0xfb, 0x90, 0x44]); // mp3 frame header bytes

  function makeClient(apiKey = 'sk-test', fetchImpl = vi.fn()) {
    return { client: new OpenAiTtsClient(() => apiKey, fetchImpl as unknown as typeof fetch), fetchImpl };
  }

  it('isConfigured returns false when key is empty', () => {
    const { client } = makeClient('');
    expect(client.isConfigured()).toBe(false);
  });

  it('isConfigured returns true when key is non-empty', () => {
    const { client } = makeClient('sk-abc');
    expect(client.isConfigured()).toBe(true);
  });

  it('throws when synthesizing without a key', async () => {
    const { client } = makeClient('');
    await expect(client.synthesize({ text: 'hi', voice: 'alloy', format: 'mp3' }))
      .rejects.toThrow(/not configured/);
  });

  it('sends a correctly-shaped POST and returns audio bytes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () =>
        fakeAudio.buffer.slice(fakeAudio.byteOffset, fakeAudio.byteOffset + fakeAudio.byteLength),
    });
    const { client } = makeClient('sk-abc', fetchImpl);

    const result = await client.synthesize({ text: 'hola mundo', voice: 'alloy', format: 'mp3' });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/audio/speech');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-abc');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      model: 'tts-1',
      input: 'hola mundo',
      voice: 'alloy',
      response_format: 'mp3',
    });
    expect(result.equals(fakeAudio)).toBe(true);
  });

  it('honours an explicit model override', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    const { client } = makeClient('sk-abc', fetchImpl);

    await client.synthesize({ text: 'x', voice: 'nova', model: 'tts-1-hd', format: 'mp3' });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe('tts-1-hd');
    expect(body.voice).toBe('nova');
  });

  it('throws with HTTP code and body excerpt on non-2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"error":{"message":"invalid api key"}}',
    });
    const { client } = makeClient('sk-bad', fetchImpl);

    await expect(client.synthesize({ text: 'x', voice: 'alloy', format: 'mp3' }))
      .rejects.toThrow(/401.*invalid api key/);
  });
});
