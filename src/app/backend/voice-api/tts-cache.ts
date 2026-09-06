import { createHash } from 'crypto';
import { TtsClient } from '@context/shared/domain/tts-client';

export interface BinaryFileStorage {
  /** Read raw bytes from [path]. Returns null if file doesn't exist. */
  read(path: string): Promise<Buffer | null>;
  /** Write [data] to [path], creating parent directories if needed. */
  write(path: string, data: Buffer): Promise<void>;
}

const DEFAULT_VOICE = 'alloy';
const DEFAULT_MODEL = 'gpt-4o-mini-tts';
const FORMAT = 'mp3';

/**
 * Lazy disk cache for synthesized audio. First lookup for a given
 * (studyItemId, side, hash(voice+model+text)) tuple does the OpenAI call;
 * subsequent lookups serve from disk.
 *
 * Concurrent requests for the same key share a single in-flight Promise
 * so we never bill OpenAI twice for the same content.
 */
export class TtsCache {
  private readonly inFlight = new Map<string, Promise<Buffer>>();

  constructor(
    private readonly storage: BinaryFileStorage,
    private readonly client: TtsClient,
    private readonly cacheDir: string = 'recall-data/voice-cache',
    private readonly voice: string = DEFAULT_VOICE,
    private readonly model: string = DEFAULT_MODEL,
    private readonly instructions: string = '',
  ) {}

  /**
   * Return the audio bytes for [text]. side and studyItemId are used
   * only to label the cache file — they do not change the audio content.
   */
  async getOrGenerate(
    studyItemId: string,
    side: 'q' | 'a',
    text: string,
  ): Promise<Buffer> {
    const hash = this.hash(text);
    const path = this.pathFor(studyItemId, side, hash);

    // 1. Disk hit
    const cached = await this.storage.read(path);
    if (cached) return cached;

    // 2. In-flight de-duplication
    const existing = this.inFlight.get(path);
    if (existing) return existing;

    // 3. Cold miss — generate, persist, broadcast
    const promise = (async () => {
      const audio = await this.client.synthesize({
        text,
        voice: this.voice,
        model: this.model,
        instructions: this.instructions || undefined,
        format: FORMAT,
      });
      await this.storage.write(path, audio);
      return audio;
    })();

    this.inFlight.set(path, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(path);
    }
  }

  private pathFor(studyItemId: string, side: 'q' | 'a', hash: string): string {
    return `${this.cacheDir}/${studyItemId}-${side}-${hash}.${FORMAT}`;
  }

  private hash(text: string): string {
    return createHash('sha256')
      .update(`${this.voice}:${this.model}:${this.instructions}:${text}`)
      .digest('hex')
      .slice(0, 12);
  }
}
