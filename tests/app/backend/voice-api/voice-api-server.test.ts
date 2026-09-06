import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Container, StorageFiles } from '@app/backend/container';
import { VaultSync } from '@app/backend/vault-sync';
import { VoiceApiServer } from '@app/backend/voice-api/voice-api-server';
import { ReviewLog } from '@context/study/domain/review-log';
import { Review } from '@context/study/domain/review';
import { StudyItemId } from '@context/study/domain/study-item-id';
import { InMemoryJsonFile } from '../../../context/shared/infrastructure/in-memory-json-storage';

// Settings shape inlined here — the real settings.ts imports from 'obsidian',
// which vitest can't resolve. Server only needs the structural fields.
type RecallSettings = {
  flashcardTags: string[];
  shuffleReviews: boolean;
  dailyNewLimit: number;
  dailyReviewLimit: number;
  leechThreshold: number;
  expandedDeckIds: string[];
  llmProvider: string;
  llmApiKey: string;
  voiceApi: { enabled: boolean; port: number; token: string; bindAddress: string };
};

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
  /** Test helper */
  count(): number { return this.reviews.length; }
}

function buildSettings(overrides: Partial<RecallSettings['voiceApi']> = {}): RecallSettings {
  return {
    flashcardTags: [],
    shuffleReviews: true,
    dailyNewLimit: 0,
    dailyReviewLimit: 0,
    leechThreshold: 8,
    expandedDeckIds: [],
    llmProvider: 'none',
    llmApiKey: '',
    voiceApi: {
      enabled: true,
      port: 0,
      bindAddress: '127.0.0.1',
      token: 'a'.repeat(64),
      ...overrides,
    },
  };
}

function buildContainer(reviewLog: InMemoryReviewLog): Container {
  const files: StorageFiles = {
    concepts: new InMemoryJsonFile(),
    studyItems: new InMemoryJsonFile(),
    decks: new InMemoryJsonFile(),
    reviewLog,
    syncState: new InMemoryJsonFile(),
  };
  return new Container(files);
}

describe('VoiceApiServer (integration)', () => {
  let server: VoiceApiServer;
  let container: Container;
  let reviewLog: InMemoryReviewLog;
  let settings: RecallSettings;
  let baseUrl: string;
  const TOKEN = 'a'.repeat(64);

  beforeEach(async () => {
    reviewLog = new InMemoryReviewLog();
    container = buildContainer(reviewLog);
    container.settings = settings = buildSettings();

    // Seed data: 2 bidirectional cards under one tagged note
    const sync = new VaultSync(container);
    await sync.syncFile(
      'vocab.md',
      [
        '---',
        'tags:',
        '  - German/vocabulary',
        '---',
        '- **Aber**:::Pero',
        '- Arbeiten:::[[trabajar]]',
      ].join('\n'),
    );

    server = new VoiceApiServer(container, settings);
    await server.start();
    const port = server.getBoundPort();
    baseUrl = `http://127.0.0.1:${port}/api/v1`;
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('GET /health', () => {
    it('returns ok without auth', async () => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    });
  });

  describe('auth', () => {
    it('rejects /decks with no token', async () => {
      const res = await fetch(`${baseUrl}/decks`);
      expect(res.status).toBe(401);
    });

    it('rejects /decks with wrong token', async () => {
      const res = await fetch(`${baseUrl}/decks`, {
        headers: { Authorization: 'Bearer wrong' },
      });
      expect(res.status).toBe(401);
    });

    it('accepts /decks with correct token', async () => {
      const res = await fetch(`${baseUrl}/decks`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
    });
  });

  describe('GET /decks', () => {
    it('returns the deck tree with due/new counts', async () => {
      const res = await fetch(`${baseUrl}/decks`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const body = await res.json();
      expect(body.decks).toBeInstanceOf(Array);
      const german = body.decks.find((d: { name: string }) => d.name === 'German');
      expect(german).toBeDefined();
      expect(german.children.length).toBeGreaterThan(0);
      const vocab = german.children.find((d: { name: string }) => d.name === 'vocabulary');
      // 2 bidirectional concepts → 4 study items, all new
      expect(vocab.totalItems).toBe(4);
      expect(vocab.newItems).toBe(4);
      expect(vocab.dueItems).toBe(4);
    });
  });

  describe('GET /due', () => {
    it('returns due items with voice-friendly text', async () => {
      const res = await fetch(`${baseUrl}/due?limit=10`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items.length).toBeGreaterThan(0);

      const aberItem = body.items.find((i: { sideA: string }) => i.sideA.includes('Aber'));
      expect(aberItem).toBeDefined();
      // Markdown bold has been stripped for voice
      expect(aberItem.voiceQuestion).not.toContain('**');
      expect(aberItem.voiceAnswer).not.toContain('**');
      // Wikilinks unwrapped
      const arbeitenItem = body.items.find((i: { sideA: string }) => i.sideA === 'Arbeiten');
      expect(arbeitenItem).toBeDefined();
      const voiceText = `${arbeitenItem.voiceQuestion} ${arbeitenItem.voiceAnswer}`;
      expect(voiceText).not.toContain('[[');
      expect(voiceText).toContain('trabajar');
    });

    it('respects the limit query param', async () => {
      const res = await fetch(`${baseUrl}/due?limit=2`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const body = await res.json();
      expect(body.items.length).toBeLessThanOrEqual(2);
    });

    it('filters by deckId', async () => {
      const decksRes = await fetch(`${baseUrl}/decks`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const { decks } = await decksRes.json();
      const vocab = decks[0].children.find((d: { name: string }) => d.name === 'vocabulary');

      const res = await fetch(`${baseUrl}/due?deckId=${vocab.id}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const body = await res.json();
      expect(body.items.length).toBeGreaterThan(0);
    });
  });

  describe('POST /reviews', () => {
    async function getFirstStudyItem(): Promise<string> {
      const res = await fetch(`${baseUrl}/due?limit=1`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const body = await res.json();
      return body.items[0].studyItemId;
    }

    it('applies a single review and persists it to the log', async () => {
      const studyItemId = await getFirstStudyItem();
      const res = await fetch(`${baseUrl}/reviews`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reviews: [{ studyItemId, rating: 'good' }] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.applied).toBe(1);
      expect(body.errors).toEqual([]);
      expect(reviewLog.count()).toBe(1);
    });

    it('applies a batch and reports per-item errors', async () => {
      const studyItemId = await getFirstStudyItem();
      const res = await fetch(`${baseUrl}/reviews`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reviews: [
            { studyItemId, rating: 'good' },
            { studyItemId: 'does-not-exist', rating: 'easy' },
            { studyItemId, rating: 'banana' },
          ],
        }),
      });
      const body = await res.json();
      expect(body.applied).toBe(1);
      expect(body.errors).toHaveLength(2);
      expect(body.errors[0].idx).toBe(1);
      expect(body.errors[0].reason).toMatch(/not found/);
      expect(body.errors[1].idx).toBe(2);
      expect(body.errors[1].reason).toMatch(/unknown rating/);
    });

    it('rejects malformed body with 400', async () => {
      const res = await fetch(`${baseUrl}/reviews`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ wrong: 'shape' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('unknown routes', () => {
    it('returns 404 for unknown path', async () => {
      const res = await fetch(`${baseUrl}/nonexistent`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(404);
    });

    it('returns 404 for path outside the API prefix', async () => {
      const url = baseUrl.replace('/api/v1', '/random');
      const res = await fetch(url);
      expect(res.status).toBe(404);
    });
  });
});
