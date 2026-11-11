import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TtsCache, type BinaryFileStorage } from '../../../src/server/audio/tts-cache';
import { TtsClient } from '@context/shared/domain/tts-client';

class InMemoryBinaryStorage implements BinaryFileStorage {
  private readonly files = new Map<string, Buffer>();
  async read(path: string): Promise<Buffer | null> {
    return this.files.get(path) ?? null;
  }
  async write(path: string, data: Buffer): Promise<void> {
    this.files.set(path, data);
  }
  has(path: string): boolean { return this.files.has(path); }
  size(): number { return this.files.size; }
}

function makeClient(overrides: Partial<TtsClient> = {}): TtsClient & { synthesize: ReturnType<typeof vi.fn> } {
  return {
    isConfigured: () => true,
    synthesize: vi.fn().mockResolvedValue(Buffer.from([1, 2, 3, 4])),
    ...overrides,
  } as TtsClient & { synthesize: ReturnType<typeof vi.fn> };
}

describe('TtsCache', () => {
  let storage: InMemoryBinaryStorage;
  let client: TtsClient & { synthesize: ReturnType<typeof vi.fn> };
  let cache: TtsCache;

  beforeEach(() => {
    storage = new InMemoryBinaryStorage();
    client = makeClient();
    cache = new TtsCache(storage, client);
  });

  it('on cold miss: calls TTS and persists to disk', async () => {
    const audio = await cache.getOrGenerate('item-1', 'q', 'hola');
    expect(audio).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(client.synthesize).toHaveBeenCalledOnce();
    expect(storage.size()).toBe(1);
  });

  it('on subsequent calls: serves from disk without calling TTS', async () => {
    await cache.getOrGenerate('item-1', 'q', 'hola');
    await cache.getOrGenerate('item-1', 'q', 'hola');
    await cache.getOrGenerate('item-1', 'q', 'hola');
    expect(client.synthesize).toHaveBeenCalledOnce();
  });

  it('different text produces a different cache file', async () => {
    await cache.getOrGenerate('item-1', 'q', 'hola');
    await cache.getOrGenerate('item-1', 'q', 'adios');
    expect(client.synthesize).toHaveBeenCalledTimes(2);
    expect(storage.size()).toBe(2);
  });

  it('different side under the same item produces a separate file', async () => {
    await cache.getOrGenerate('item-1', 'q', 'hola');
    await cache.getOrGenerate('item-1', 'a', 'hola');
    expect(client.synthesize).toHaveBeenCalledTimes(2);
    expect(storage.size()).toBe(2);
  });

  it('concurrent requests for the same key share a single TTS call', async () => {
    let resolveSynthesize: (b: Buffer) => void = () => {};
    client.synthesize.mockImplementation(() =>
      new Promise<Buffer>((resolve) => { resolveSynthesize = resolve; }));

    const a = cache.getOrGenerate('item-1', 'q', 'hola');
    const b = cache.getOrGenerate('item-1', 'q', 'hola');
    const c = cache.getOrGenerate('item-1', 'q', 'hola');

    // Yield long enough for the storage.read awaits to settle and the in-flight
    // promise to be registered + synthesize() to be invoked.
    await new Promise((r) => setTimeout(r, 10));
    resolveSynthesize(Buffer.from([7]));

    const [r1, r2, r3] = await Promise.all([a, b, c]);
    expect(r1).toEqual(Buffer.from([7]));
    expect(r2).toEqual(Buffer.from([7]));
    expect(r3).toEqual(Buffer.from([7]));
    expect(client.synthesize).toHaveBeenCalledOnce();
  });

  it('keeps the legacy OpenAI file name and scopes other providers', async () => {
    await cache.getOrGenerate('item', 'q', 'hola');
    // Pinned from the pre-provider code: sha256("alloy:gpt-4o-mini-tts::hola").slice(0, 12).
    expect(storage.has('recall-data/voice-cache/item-q-1e0107e3e2dc.mp3')).toBe(true);
    const gemini = new TtsCache(storage, client, 'recall-data/voice-cache', 'alloy', 'gpt-4o-mini-tts', '', 'gemini');
    await gemini.getOrGenerate('item', 'q', 'hola');
    expect(client.synthesize).toHaveBeenCalledTimes(2);
    expect(storage.size()).toBe(2);
  });

  it('regenerates over an empty cached file', async () => {
    await storage.write('recall-data/voice-cache/item-q-1e0107e3e2dc.mp3', Buffer.alloc(0));
    expect(await cache.getOrGenerate('item', 'q', 'hola')).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('after a synthesize failure, the next call retries (does not poison cache)', async () => {
    client.synthesize
      .mockRejectedValueOnce(new Error('rate limit'))
      .mockResolvedValueOnce(Buffer.from([9]));

    await expect(cache.getOrGenerate('item-1', 'q', 'hola')).rejects.toThrow(/rate limit/);
    const audio = await cache.getOrGenerate('item-1', 'q', 'hola');
    expect(audio).toEqual(Buffer.from([9]));
    expect(client.synthesize).toHaveBeenCalledTimes(2);
  });
});
