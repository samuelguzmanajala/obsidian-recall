import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Container, StorageFiles } from '@app/backend/container';
import { VaultSync } from '@app/backend/vault-sync';
import { VoiceApiServer } from '@app/backend/voice-api/voice-api-server';
import { TtsCache } from '@app/backend/voice-api/tts-cache';
import { ReviewLog } from '@context/study/domain/review-log';
import { Review } from '@context/study/domain/review';
import { StudyItemId } from '@context/study/domain/study-item-id';
import { InMemoryJsonFile } from '../../../../context/shared/infrastructure/in-memory-json-storage';

class InMemoryReviewLog implements ReviewLog {
  private reviews: Review[] = [];
  async append(r: Review): Promise<void> { this.reviews.push(r); }
  async findByStudyItemId(id: StudyItemId): Promise<Review[]> {
    return this.reviews.filter(r => r.studyItemId.equals(id));
  }
  async findAll(): Promise<Review[]> { return [...this.reviews]; }
  async findSince(since: Date): Promise<Review[]> {
    return this.reviews.filter(r => r.timestamp >= since);
  }
}

type Settings = {
  flashcardTags: string[]; shuffleReviews: boolean; dailyNewLimit: number;
  dailyReviewLimit: number; leechThreshold: number; expandedDeckIds: string[];
  llmProvider: string; llmApiKey: string;
  voiceApi: { enabled: boolean; port: number; token: string; bindAddress: string };
};

function buildSettings(): Settings {
  return {
    flashcardTags: [], shuffleReviews: false, dailyNewLimit: 0, dailyReviewLimit: 0,
    leechThreshold: 8, expandedDeckIds: [], llmProvider: 'none', llmApiKey: '',
    voiceApi: { enabled: true, port: 0, bindAddress: '127.0.0.1', token: 'a'.repeat(64) },
  };
}

function buildContainer(): Container {
  const files: StorageFiles = {
    concepts: new InMemoryJsonFile(),
    studyItems: new InMemoryJsonFile(),
    decks: new InMemoryJsonFile(),
    reviewLog: new InMemoryReviewLog(),
    syncState: new InMemoryJsonFile(),
  };
  return new Container(files);
}

describe('GET /audio/:studyItemId/:side', () => {
  const TOKEN = 'a'.repeat(64);
  const FAKE_AUDIO = Buffer.from([0xff, 0xfb, 0x90, 0x44, 0x55]);
  let server: VoiceApiServer;
  let baseUrl: string;
  let synthesize: ReturnType<typeof vi.fn>;
  let firstStudyItemId: string;

  beforeEach(async () => {
    const container = buildContainer();
    container.settings = buildSettings() as any;

    // Seed one bidirectional concept → 2 study items
    const sync = new VaultSync(container);
    await sync.syncFile(
      'vocab.md',
      [
        '---', 'tags:', '  - test', '---',
        '- **neglect** (No `___` tu salud):::descuidar (Don\'t `___` your health)',
      ].join('\n'),
    );
    const items = await container.studyItemRepository.findAll();
    firstStudyItemId = items[0].id.value;

    synthesize = vi.fn().mockResolvedValue(FAKE_AUDIO);

    const cache = new TtsCache(
      {
        async read() { return null; },
        async write() { /* noop */ },
      },
      { synthesize, isConfigured: () => true },
    );

    const settings = buildSettings();
    server = new VoiceApiServer(container, settings as any, {
      ttsCache: cache,
      rewriter: null,
      isTtsConfigured: () => true,
    });
    await server.start();
    baseUrl = `http://127.0.0.1:${server.getBoundPort()}/api/v1`;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('returns mp3 bytes for question side with audio/mpeg content-type', async () => {
    const res = await fetch(`${baseUrl}/audio/${firstStudyItemId}/question`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(FAKE_AUDIO)).toBe(true);
  });

  it('returns audio for answer side too', async () => {
    const res = await fetch(`${baseUrl}/audio/${firstStudyItemId}/answer`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it('strips markdown and underscores before synthesize', async () => {
    await fetch(`${baseUrl}/audio/${firstStudyItemId}/question`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(synthesize).toHaveBeenCalledOnce();
    const passedText = synthesize.mock.calls[0][0].text;
    // Markdown ** stripped, backticks gone, underscores → "espacio en blanco"
    expect(passedText).not.toContain('**');
    expect(passedText).not.toContain('`');
    expect(passedText).not.toContain('___');
    // Underscores → ellipsis (natural TTS pause), not literal words
    expect(passedText).toContain('…');
    expect(passedText).not.toContain('espacio en blanco');
  });

  it('returns 401 without bearer', async () => {
    const res = await fetch(`${baseUrl}/audio/${firstStudyItemId}/question`);
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown studyItemId', async () => {
    const res = await fetch(`${baseUrl}/audio/00000000-0000-0000-0000-000000000000/question`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it('returns 503 when TTS is not configured', async () => {
    await server.stop();
    const container = buildContainer();
    container.settings = buildSettings() as any;
    server = new VoiceApiServer(container, buildSettings() as any, {
      ttsCache: null,
      rewriter: null,
      isTtsConfigured: () => false,
    });
    await server.start();
    baseUrl = `http://127.0.0.1:${server.getBoundPort()}/api/v1`;

    const res = await fetch(`${baseUrl}/audio/${firstStudyItemId}/question`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(503);
  });
});
