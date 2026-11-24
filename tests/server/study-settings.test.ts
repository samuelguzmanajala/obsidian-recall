import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecallDatabase } from '../../src/server/database';
import { RecallService } from '../../src/server/service';
import { createRecallServer } from '../../src/server/http';
import type { AudioQueue } from '../../src/server/audio/audio-queue';
import { RECALL_TOOLS } from '../../src/server/mcp/tools';
import { Rating } from '../../src/context/study/domain/rating';
import { StudyItem } from '../../src/context/study/domain/study-item';
import { MemoryState } from '../../src/context/study/domain/memory-state';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

const NOTES: Record<string, string> = {
  'German.md': '---\ntags: [German/grammar]\n---\nder Hund::the dog\ndie Katze:::the cat',
  'Vocab.md': '---\ntags:\n  - German/vocab\n  - travel\n---\nder Zug::the train',
  'Spanish.md': '---\ntags: Spanish\n---\nhola::hello',
  'Loose.md': 'sin tags::untagged card',
  'Prose.md': '---\ntags: [German]\n---\nNo cards here.',
};
const ENV = { shuffleReviews: false, dailyNewLimit: 0, dailyReviewLimit: 0, leechThreshold: 8, flashcardTags: ['German'] };

async function setup(env: Partial<RecallService['settings']> = ENV, path = ':memory:') {
  const db = new RecallDatabase(path);
  cleanup.push(() => db.close());
  const service = new RecallService(db, env);
  await service.reindexIfTagsChanged();
  for (const [p, content] of Object.entries(NOTES)) await service.note({ operationId: randomUUID(), path: p, content, expectedRevision: 0 });
  return service;
}
async function serve(service: RecallService, queue?: Pick<AudioQueue, 'enqueue'>) {
  const token = 'test-secret-'.repeat(4);
  const server = createRecallServer(service, token, undefined, queue as AudioQueue | undefined);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise(r => server.close(r)));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${url}${path}`, { method, headers: { Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as any };
  };
  return { get: (path: string) => call('GET', path), post: (path: string, body: unknown) => call('POST', path, body) };
}
const items = (service: RecallService) => service.query(async c => (await c.studyItemRepository.findAll()).map(i => i.id.value).sort());
const sides = (service: RecallService) => service.query(async c => {
  const out: string[] = [];
  for (const item of await c.studyItemRepository.findAll()) out.push(`${(await c.conceptRepository.findById(item.conceptId))!.sideA.content}:${item.direction}`);
  return out.sort();
});
const metaRows = (service: RecallService) => service.db.transaction(async () => service.db.sql.prepare('SELECT key,value FROM meta ORDER BY key').all());
const receipts = (service: RecallService) => service.db.transaction(async () => Number(service.db.sql.prepare('SELECT COUNT(*) AS n FROM operations').get()!.n));
const update = (service: RecallService, settings: unknown, expectedRevision = 0, extra: Record<string, unknown> = {}) =>
  service.updateSettings({ operationId: randomUUID(), expectedRevision, settings, ...extra });

describe('study settings: precedence', () => {
  it('serves the environment values until settings are stored, without writing them at startup', async () => {
    const service = await setup();
    const { get } = await serve(service);
    expect((await get('/settings')).body).toEqual({ settings: { ...ENV, flashcardTags: ['German'] }, source: 'environment', revision: 0 });
    expect((await metaRows(service)).map(r => r.key)).toEqual(['index-tags']);
    await update(service, { dailyNewLimit: 5 });
    expect((await get('/settings')).body).toEqual({ settings: { ...ENV, dailyNewLimit: 5 }, source: 'stored', revision: 1 });
  });

  it('stored settings win over the environment after a restart, and a reset goes back to it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recall-settings-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'recall.sqlite');
    const first = new RecallService(new RecallDatabase(path), ENV);
    for (const [p, content] of Object.entries(NOTES)) await first.note({ operationId: randomUUID(), path: p, content, expectedRevision: 0 });
    await update(first, { flashcardTags: ['Spanish'], leechThreshold: 3 });
    await first.db.close();
    const db = new RecallDatabase(path);
    cleanup.push(() => db.close());
    const restarted = new RecallService(db, { ...ENV, flashcardTags: ['German'], leechThreshold: 20 });
    expect(restarted.settings).toMatchObject({ flashcardTags: ['Spanish'], leechThreshold: 3 });
    const before = await items(restarted);
    await restarted.reindexIfTagsChanged(); // index already built with the stored tags: nothing to do
    expect(await items(restarted)).toEqual(before);
    expect(await sides(restarted)).toEqual(['hola:a-to-b']);
    const reset = await restarted.updateSettings({ operationId: randomUUID(), expectedRevision: 1, reset: true });
    expect(reset).toMatchObject({ source: 'environment', revision: 2, settings: { flashcardTags: ['German'], leechThreshold: 20 } });
    expect(restarted.settings.leechThreshold).toBe(20);
    expect(await sides(restarted)).toEqual(['der Hund:a-to-b', 'der Zug:a-to-b', 'die Katze:a-to-b', 'die Katze:b-to-a']);
    expect(await restarted.readSettings()).toMatchObject({ source: 'environment', revision: 2 });
  });
});

describe('POST /api/v1/settings validation', () => {
  it.each([
    [{ expectedRevision: 0, settings: { dailyNewLimit: 1 } }, 'Invalid operationId'],
    [{ operationId: 'x', settings: { dailyNewLimit: 1 } }, 'expectedRevision is required'],
    [{ operationId: 'x', expectedRevision: 0 }, 'Expected an object'],
    [{ operationId: 'x', expectedRevision: 0, settings: {} }, 'settings must contain at least one field'],
    [{ operationId: 'x', expectedRevision: 0, settings: { dailyNew: 1 } }, 'Unknown settings: dailyNew'],
    [{ operationId: 'x', expectedRevision: 0, settings: { dailyNewLimit: -1 } }, 'dailyNewLimit must be an integer from 0 to 100000'],
    [{ operationId: 'x', expectedRevision: 0, settings: { dailyReviewLimit: 1.5 } }, 'dailyReviewLimit must be an integer from 0 to 100000'],
    [{ operationId: 'x', expectedRevision: 0, settings: { leechThreshold: '8' } }, 'leechThreshold must be an integer from 0 to 1000'],
    [{ operationId: 'x', expectedRevision: 0, settings: { shuffleReviews: 'false' } }, 'shuffleReviews must be a boolean'],
    [{ operationId: 'x', expectedRevision: 0, settings: { flashcardTags: 'German' } }, 'flashcardTags must be an array of strings'],
    [{ operationId: 'x', expectedRevision: 0, settings: { flashcardTags: ['#German'] } }, 'Write tags without #'],
    [{ operationId: 'x', expectedRevision: 0, settings: { flashcardTags: ['  '] } }, 'Each tag must have 1–200 characters'],
    [{ operationId: 'x', expectedRevision: 0, settings: { flashcardTags: ['x'.repeat(201)] } }, 'Each tag must have 1–200 characters'],
    [{ operationId: 'x', expectedRevision: 0, settings: { flashcardTags: Array.from({ length: 201 }, (_, i) => `t${i}`) } }, 'flashcardTags allows at most 200 tags'],
    [{ operationId: 'x', expectedRevision: 0, settings: { dailyNewLimit: 1 }, dryRun: 'yes' }, 'dryRun must be a boolean'],
    [{ operationId: 'x', expectedRevision: 0, settings: { dailyNewLimit: 1 }, reset: true }, 'Send either settings or reset, not both'],
  ])('rejects %j', async (body, error) => {
    const service = await setup();
    const { post } = await serve(service);
    expect(await post('/settings', body)).toEqual({ status: 400, body: { error } });
    expect(await service.readSettings()).toMatchObject({ revision: 0, source: 'environment' });
  });

  it('trims, de-duplicates and sorts tags; an empty list follows every note with cards', async () => {
    const service = await setup();
    const result = await update(service, { flashcardTags: [' Spanish', 'German ', 'Spanish'] });
    expect(result.settings.flashcardTags).toEqual(['German', 'Spanish']);
    const all = await update(service, { flashcardTags: [] }, 1);
    expect(all.settings.flashcardTags).toEqual([]);
    expect(await sides(service)).toContain('sin tags:a-to-b');
  });
});

describe('POST /api/v1/settings concurrency and idempotency', () => {
  it('rejects a stale revision with 409 and changes nothing', async () => {
    const service = await setup();
    const { post } = await serve(service);
    await update(service, { dailyNewLimit: 3 });
    const stale = await post('/settings', { operationId: randomUUID(), expectedRevision: 0, settings: { dailyNewLimit: 9 } });
    expect(stale).toEqual({ status: 409, body: { error: 'Settings changed on another device; reload them' } });
    const staleDryRun = await post('/settings', { operationId: randomUUID(), expectedRevision: 0, settings: { dailyNewLimit: 9 }, dryRun: true });
    expect(staleDryRun.status).toBe(409);
    expect(service.settings.dailyNewLimit).toBe(3);
  });

  it('answers a retry with the original receipt, and refuses the same operationId for another command', async () => {
    const service = await setup();
    const { post } = await serve(service);
    const body = { operationId: randomUUID(), expectedRevision: 0, settings: { flashcardTags: ['Spanish'] } };
    const first = await post('/settings', body);
    expect(first.status).toBe(200);
    const revisions = await service.db.transaction(async () => service.db.sql.prepare('SELECT * FROM item_revisions ORDER BY study_item_id').all());
    expect(await post('/settings', body)).toEqual(first);
    expect(await service.readSettings()).toMatchObject({ revision: 1 });
    expect(await service.db.transaction(async () => service.db.sql.prepare('SELECT * FROM item_revisions ORDER BY study_item_id').all())).toEqual(revisions);
    expect((await post('/settings', { ...body, settings: { flashcardTags: ['German'] } })).status).toBe(409);
  });
});

describe('dry run', () => {
  it('computes the same impact as the real change and persists nothing', async () => {
    const service = await setup();
    const { post } = await serve(service);
    const snapshot = async () => ({
      meta: await metaRows(service), receipts: await receipts(service), items: await items(service),
      revisions: await service.db.transaction(async () => service.db.sql.prepare('SELECT * FROM item_revisions ORDER BY study_item_id').all()),
      decks: await service.query(c => c.getDeckTree.execute()), tags: await service.query(c => c.sources.snapshot()),
    });
    const before = await snapshot();
    const operationId = randomUUID();
    const body = { operationId, expectedRevision: 0, settings: { flashcardTags: ['Spanish', 'travel'], dailyNewLimit: 7 } };
    const dry = await post('/settings', { ...body, dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body).toEqual({
      settings: { ...ENV, flashcardTags: ['Spanish', 'travel'], dailyNewLimit: 7 }, source: 'stored', revision: 1, dryRun: true,
      impact: { notes: 5, cardsBefore: 4, cardsAfter: 2, cardsAdded: 1, cardsRemoved: 3, decksBefore: 3, decksAfter: 2 },
    });
    expect(await snapshot()).toEqual(before);
    expect(service.settings).toMatchObject({ flashcardTags: ['German'], dailyNewLimit: 0 });
    expect(await service.readSettings()).toMatchObject({ revision: 0, source: 'environment' });
    // The same operationId still applies for real: the dry run left no receipt.
    const real = await post('/settings', body);
    expect(real.body).toEqual({ ...dry.body, dryRun: undefined });
    expect(real.body.impact).toEqual(dry.body.impact);
    expect(await receipts(service)).toBe(before.receipts + 1);
  });
});

describe('tag changes re-index published notes', () => {
  it('removes and restores cards with their review state; the review log is untouched', async () => {
    const service = await setup();
    const dog = (await service.due()).items.find(i => i.sideA === 'der Hund')!;
    await service.review({ operationId: randomUUID(), studyItemId: dog.studyItemId, rating: Rating.Good, expectedRevision: dog.revision });
    const state = await service.query(async c => (await c.studyItemRepository.findAll()).find(i => i.id.value === dog.studyItemId)!.memoryState);
    const log = await service.query(c => c.reviewLog.findAll());

    const removed = await update(service, { flashcardTags: ['Spanish'] });
    expect(removed.impact).toMatchObject({ cardsRemoved: 4, cardsAdded: 1, cardsAfter: 1 });
    expect(await sides(service)).toEqual(['hola:a-to-b']);
    expect(await service.query(c => c.reviewLog.findAll())).toEqual(log);
    // A queued answer for a removed card is refused rather than resurrecting it.
    await expect(service.review({ operationId: randomUUID(), studyItemId: dog.studyItemId, rating: Rating.Good, expectedRevision: dog.revision }))
      .rejects.toMatchObject({ status: 404 });

    const restored = await update(service, { flashcardTags: ['German/grammar', 'Spanish'] }, 1);
    expect(restored.impact).toMatchObject({ cardsAdded: 3, cardsRemoved: 0, cardsAfter: 4 });
    const back = await service.query(async c => (await c.studyItemRepository.findAll()).find(i => i.id.value === dog.studyItemId)!);
    expect(back.memoryState).toEqual(state);
    // Item revisions were bumped, so stale clients must refresh before answering.
    const revision = await service.db.transaction(async () => Number(service.db.sql.prepare('SELECT revision FROM item_revisions WHERE study_item_id=?').get(dog.studyItemId)!.revision));
    expect(revision).toBe(dog.revision + 3); // review, removal, restoration
    expect(await service.query(c => c.reviewLog.findAll())).toEqual(log);
  });

  it('a change of limits only does not touch the index', async () => {
    const service = await setup();
    const revisions = async () => service.db.transaction(async () => service.db.sql.prepare('SELECT * FROM item_revisions ORDER BY study_item_id').all());
    const before = await revisions();
    const result = await update(service, { dailyNewLimit: 1, leechThreshold: 2 });
    expect(result.impact).toEqual({ notes: 0, cardsBefore: 4, cardsAfter: 4, cardsAdded: 0, cardsRemoved: 0, decksBefore: 3, decksAfter: 3 });
    expect(await revisions()).toEqual(before);
  });

  it('notes published after the change use the new filter at once', async () => {
    const service = await setup();
    await update(service, { flashcardTags: ['Other'] });
    await service.note({ operationId: randomUUID(), path: 'New.md', content: '---\ntags: Other\n---\nneu::new', expectedRevision: 0 });
    expect(await sides(service)).toEqual(['neu:a-to-b']);
  });
});

describe('limits, leech threshold and shuffle apply without a restart', () => {
  async function studied(service: RecallService, lapses: number) {
    await service.query(async c => {
      for (const item of await c.studyItemRepository.findAll()) {
        const s = item.memoryState;
        await c.studyItemRepository.save(StudyItem.reconstitute(item.id, item.conceptId, item.direction,
          new MemoryState(s.stability, s.difficulty, s.due, 0, lapses, s.lastReview)));
      }
    });
  }
  it('the next /due, /leeches and MCP calls see the new values', async () => {
    const service = await setup({ ...ENV, dailyNewLimit: 0, leechThreshold: 8 });
    await studied(service, 3);
    const { get } = await serve(service);
    expect((await get('/due')).body.items).toHaveLength(3); // the two directions of a card are never both due today
    expect((await get('/leeches')).body).toHaveLength(0);
    await update(service, { dailyNewLimit: 2, leechThreshold: 3 });
    expect((await get('/due')).body.items).toHaveLength(2);
    expect((await get('/leeches')).body).toHaveLength(4);
    const tool = (name: string) => RECALL_TOOLS.find(t => t.name === name)!.call(service, {}).then(r => r.structuredContent as any);
    expect(await tool('get_leeches')).toMatchObject({ threshold: 3, total: 4 });
    expect(await tool('get_due_cards')).toMatchObject({ newLeftToday: 2 });
    expect(await tool('get_study_stats')).toMatchObject({ newLeftToday: 2 });
    await update(service, { dailyNewLimit: 0 }, 1);
    expect(await tool('get_due_cards')).toMatchObject({ newLeftToday: null });
    expect(await tool('list_decks')).toMatchObject({ decks: expect.any(Array) });
  });

  it('turns shuffling on and off', async () => {
    const service = await setup({ ...ENV, flashcardTags: ['x'] }); // one-way cards only: no random choice of direction
    for (let i = 0; i < 30; i++) await service.note({ operationId: randomUUID(), path: `N${i}.md`, content: `---\ntags: x\n---\nq${i}::a${i}`, expectedRevision: 0 });
    const order = async () => (await service.due(undefined, 100)).items.map(i => i.studyItemId).join();
    const fixed = await order();
    expect(await order()).toBe(fixed);
    await update(service, { shuffleReviews: true });
    const random = vi.spyOn(Math, 'random');
    await order();
    expect(random).toHaveBeenCalled();
    random.mockRestore();
    await update(service, { shuffleReviews: false }, 1);
    expect(await order()).toBe(fixed);
  });
});

describe('GET /api/v1/tags', () => {
  it('lists every tag with its ancestors, coverage counts, selection and the untagged notes', async () => {
    const service = await setup();
    const { get } = await serve(service);
    expect((await get('/tags')).body).toEqual({
      tags: [
        { tag: 'German', notes: 3, cards: 4, selected: true, followed: true },
        { tag: 'German/grammar', notes: 1, cards: 3, selected: false, followed: true },
        { tag: 'German/vocab', notes: 1, cards: 1, selected: false, followed: true },
        { tag: 'Spanish', notes: 1, cards: 1, selected: false, followed: false },
        { tag: 'travel', notes: 1, cards: 1, selected: false, followed: false },
      ],
      untagged: { notes: 1, cards: 1, followed: false },
    });
  });

  it('follows the current filter, keeps selected tags no note has, and re-parses only changed notes', async () => {
    const service = await setup();
    await update(service, { flashcardTags: ['German/vocab', 'Gone'] });
    const parse = vi.spyOn(service.container.parser, 'parse');
    const first = await service.tags();
    expect(first.tags.find(t => t.tag === 'Gone')).toEqual({ tag: 'Gone', notes: 0, cards: 0, selected: true, followed: true });
    expect(first.tags.find(t => t.tag === 'German')).toMatchObject({ selected: false, followed: false });
    expect(first.tags.find(t => t.tag === 'German/vocab')).toMatchObject({ selected: true, followed: true });
    expect(parse).toHaveBeenCalledTimes(5); // first call: every published note
    parse.mockClear();
    await service.tags();
    expect(parse).not.toHaveBeenCalled();
    await service.note({ operationId: randomUUID(), path: 'Spanish.md', content: '---\ntags: Spanish\n---\nhola::hello\nadiós:::bye', expectedRevision: 1 });
    parse.mockClear();
    const second = await service.tags();
    expect(parse).toHaveBeenCalledTimes(1);
    expect(second.tags.find(t => t.tag === 'Spanish')).toMatchObject({ notes: 1, cards: 3 });
    await update(service, { flashcardTags: [] }, 1);
    expect((await service.tags()).untagged).toEqual({ notes: 1, cards: 1, followed: true });
  });
});

describe('background audio', () => {
  it('enqueues the cards a tag change adds, after the commit, and nothing on dry runs or retries', async () => {
    const service = await setup();
    const queue = { enqueue: vi.fn() };
    const { post } = await serve(service, queue);
    const body = { operationId: randomUUID(), expectedRevision: 0, settings: { flashcardTags: ['German', 'Spanish'] } };
    await post('/settings', { ...body, dryRun: true });
    expect(queue.enqueue).not.toHaveBeenCalled();
    await post('/settings', body);
    const hola = (await service.due()).items.find(i => i.sideA === 'hola')!.studyItemId;
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith([hola]);
    await post('/settings', body);
    await post('/settings', { operationId: randomUUID(), expectedRevision: 1, settings: { flashcardTags: ['German'] } });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });
});
