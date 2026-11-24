import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RecallDatabase } from '../../../src/server/database';
import { RecallService } from '../../../src/server/service';
import { createRecallServer } from '../../../src/server/http';
import { RECALL_TOOLS, ToolInputError } from '../../../src/server/mcp/tools';
import { MAX_SIDE_CHARS } from '../../../src/server/mcp/card-views';
import { DATA_TABLES } from '../../../src/server/persistence/schema';
import { StudyItem } from '../../../src/context/study/domain/study-item';
import { MemoryState } from '../../../src/context/study/domain/memory-state';
import { Review } from '../../../src/context/study/domain/review';
import { Rating } from '../../../src/context/study/domain/rating';
import { Direction } from '../../../src/context/study/domain/direction';
import { GetWeakStudyItems, weaknessScore } from '../../../src/context/study/application/get-weak-study-items';
import { inMemoryStores } from '../../context/fakes/in-memory';
import { StudyItemId } from '../../../src/context/study/domain/study-item-id';
import { ConceptId } from '../../../src/context/concept/domain/concept-id';

const DAY = 86_400_000;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

const LONG = 'x'.repeat(MAX_SIDE_CHARS + 300);
const NOTES: Record<string, string> = {
  'German.md': '---\ntags: german/grammar\n---\nder Hund::the dog\ndie Katze::the cat\nder Vogel::the bird\nGuten Morgen:::good morning',
  'Spanish.md': '---\ntags: spanish\n---\nAdiós:::goodbye\nhola::hello',
  'Code.md': `---\ntags: tech\n---\nWhat does it print?::${LONG}`,
};

/** Each card's study items by "sideA" (a→b) or "sideA<" (b→a). */
async function setup(settings: Partial<RecallService['settings']> = {}) {
  const db = new RecallDatabase(':memory:');
  cleanup.push(() => db.close());
  const service = new RecallService(db, { shuffleReviews: false, dailyNewLimit: 2, dailyReviewLimit: 0, leechThreshold: 3, ...settings });
  for (const [path, content] of Object.entries(NOTES)) await service.note({ operationId: randomUUID(), path, content, expectedRevision: 0 });
  const items = await service.query(async c => {
    const byKey = new Map<string, StudyItem>();
    for (const item of await c.studyItemRepository.findAll()) {
      const concept = (await c.conceptRepository.findById(item.conceptId))!;
      byKey.set(item.direction === Direction.AtoB ? concept.sideA.content : `${concept.sideA.content}<`, item);
    }
    return byKey;
  });
  const id = (key: string) => items.get(key)!.id.value;
  /** Gives a card a studied state (and optional review history) without going through the review rules. */
  const study = (key: string, state: Partial<{ due: number; reps: number; lapses: number; difficulty: number; stability: number }>, reviews: [number, Rating][] = []) =>
    service.query(async c => {
      const item = items.get(key)!;
      const s = { due: Date.now() - DAY, reps: 3, lapses: 0, difficulty: 5, stability: 10, ...state };
      await c.studyItemRepository.save(StudyItem.reconstitute(item.id, item.conceptId, item.direction,
        new MemoryState(s.stability, s.difficulty, new Date(s.due), s.reps, s.lapses, new Date(s.due - DAY))));
      for (const [at, rating] of reviews) await c.reviewLog.append(new Review(item.id, rating, new Date(at)));
    });
  return { db, service, id, study };
}
const tool = (name: string) => RECALL_TOOLS.find(t => t.name === name)!;
async function call(service: RecallService, name: string, args: Record<string, unknown> = {}) {
  const result = await tool(name).call(service, args);
  expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  return result.structuredContent as Record<string, any>;
}
async function deckId(service: RecallService, path: string) {
  const { decks } = await call(service, 'list_decks');
  let level = decks, node: any;
  for (const name of path.split('/')) { node = level.find((d: any) => d.name === name); level = node.children; }
  return node.id as string;
}
function snapshot(db: RecallDatabase) {
  const tables = [...DATA_TABLES, 'operations', 'notes'];
  return Object.fromEntries(tables.map(t => [t, db.sql.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
}

describe('MCP tools', () => {
  it('lists six read-only tools with strict object schemas', () => {
    expect(RECALL_TOOLS.map(t => t.name)).toEqual(['list_decks', 'get_due_cards', 'get_weak_cards', 'get_leeches', 'search_cards', 'get_study_stats']);
    for (const t of RECALL_TOOLS) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(t.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(t.description.length).toBeGreaterThan(80);
    }
  });

  it('get_due_cards: reviews first by due date, then new cards within the daily allowance, oriented by direction', async () => {
    const { service, id, study } = await setup();
    await study('der Vogel', { due: Date.now() - 3 * DAY, lapses: 1 });
    await study('Adiós<', { due: Date.now() - 5 * DAY }); // b→a: the prompt is "goodbye"
    await study('Adiós', { due: Date.now() + 5 * DAY }); // not due (else the queue picks one direction at random)
    await study('hola', { due: Date.now() + 5 * DAY }); // not due
    const due = await call(service, 'get_due_cards');
    expect(due).toMatchObject({ deck: null, reviewsDue: 2, reviewsLeftToday: null, newLeftToday: 2 });
    // der Hund, die Katze, one direction of Guten Morgen (sibling dedup), the code card
    expect(due.newCardsDue).toBe(4);
    expect(due.cards.map((c: any) => c.studyItemId)).toEqual([id('Adiós<'), id('der Vogel'), id('der Hund'), id('die Katze')]);
    expect(due.cards[0]).toEqual({ studyItemId: id('Adiós<'), prompt: 'goodbye', answer: 'Adiós', decks: ['spanish'], state: 'review',
      due: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), reps: 3, lapses: 0, revision: 1, next: expect.any(Object) });
    expect(due.cards[2]).toEqual({ studyItemId: id('der Hund'), prompt: 'der Hund', answer: 'the dog', decks: ['german/grammar'], state: 'new', reps: 0, lapses: 0, revision: 1, next: expect.any(Object) });
    expect((await call(service, 'get_due_cards', { limit: 1 })).cards).toHaveLength(1);
  });

  it('get_due_cards: a deck filter covers its subdecks; daily limits shape the list', async () => {
    const { service, id } = await setup({ dailyNewLimit: 0 });
    const german = await call(service, 'get_due_cards', { deckId: await deckId(service, 'german') });
    expect(german.deck).toBe('german');
    expect(german.newLeftToday).toBeNull();
    expect(german.cards.map((c: any) => c.decks)).toEqual(Array(4).fill(['german/grammar']));
    expect(german.cards.map((c: any) => c.studyItemId)).toContain(id('der Hund'));
    const grammar = await call(service, 'get_due_cards', { deckId: await deckId(service, 'german/grammar'), limit: 50 });
    expect(grammar.deck).toBe('german/grammar');
    expect(grammar.cards).toHaveLength(4);
    expect((await call(service, 'get_due_cards', { deckId: await deckId(service, 'tech') })).cards[0]).toMatchObject({
      prompt: 'What does it print?', answer: `${'x'.repeat(MAX_SIDE_CHARS)}…`, truncated: true });
  });

  it('get_leeches: lapses at or over the threshold, worst first, with deck filter', async () => {
    const { service, id, study } = await setup();
    await study('der Hund', { lapses: 5 });
    await study('Adiós', { lapses: 3, due: Date.now() + DAY });
    await study('hola', { lapses: 2 });
    const all = await call(service, 'get_leeches');
    expect(all).toMatchObject({ deck: null, threshold: 3, total: 2 });
    expect(all.cards.map((c: any) => [c.studyItemId, c.lapses])).toEqual([[id('der Hund'), 5], [id('Adiós'), 3]]);
    expect(all.cards[1]).toMatchObject({ prompt: 'Adiós', answer: 'goodbye', decks: ['spanish'], state: 'review', due: expect.any(String) });
    const spanish = await call(service, 'get_leeches', { deckId: await deckId(service, 'spanish') });
    expect(spanish.cards.map((c: any) => c.studyItemId)).toEqual([id('Adiós')]);
    expect((await call(service, 'get_leeches', { limit: 1 })).cards).toHaveLength(1);
    expect((await call(service, 'get_leeches', { limit: 1 })).total).toBe(2);
  });

  it('get_study_stats: the stats read model plus the remaining daily allowance', async () => {
    const { service, study } = await setup();
    await study('der Hund', {});
    const stats = await call(service, 'get_study_stats');
    expect(stats).toEqual({ ...await service.query(c => c.getStudyStats.execute()), newLeftToday: 2, reviewsLeftToday: null });
    expect(stats.totalItems).toBe(9);
    expect(stats.matureItems).toBe(1);
  });

  it('search_cards: both sides, case/accent/line-break insensitive, grouped by card with each studied direction', async () => {
    const { service, id, study } = await setup();
    await study('Adiós', { lapses: 1 });
    const found = await call(service, 'search_cards', { query: 'ADIOS' });
    expect(found).toEqual({ query: 'ADIOS', deck: null, total: 1, cards: [{
      sideA: 'Adiós', sideB: 'goodbye', decks: ['spanish'], directions: [
        { studyItemId: id('Adiós'), prompt: 'sideA', state: 'review', due: expect.any(String), lapses: 1, revision: 1, next: expect.any(Object) },
        { studyItemId: id('Adiós<'), prompt: 'sideB', state: 'new', lapses: 0, revision: 1, next: expect.any(Object) },
      ] }] });
    expect((await call(service, 'search_cards', { query: 'the' })).total).toBe(3);
    expect((await call(service, 'search_cards', { query: 'the', limit: 2 })).cards.map((c: any) => c.sideA)).toEqual(['der Hund', 'die Katze']);
    expect((await call(service, 'search_cards', { query: 'the', limit: 2 })).total).toBe(3);
    expect((await call(service, 'search_cards', { query: 'good', deckId: await deckId(service, 'german') })).cards.map((c: any) => c.sideA)).toEqual(['Guten Morgen']);
    expect((await call(service, 'search_cards', { query: 'good', deckId: await deckId(service, 'tech') })).total).toBe(0);
    const long = await call(service, 'search_cards', { query: 'xxxx' });
    expect(long.cards[0]).toMatchObject({ sideA: 'What does it print?', truncated: true });
    expect([...long.cards[0].sideB]).toHaveLength(MAX_SIDE_CHARS + 1);
  });

  it('get_weak_cards: recent Again ratings, lapses and difficulty, shakiest first, with window and deck filter', async () => {
    const { service, id, study } = await setup();
    const now = Date.now();
    await study('der Hund', { lapses: 1, difficulty: 6, due: now + 10 * DAY }, [[now - 2 * DAY, Rating.Again], [now - DAY / 2, Rating.Again]]);
    await study('Adiós', { lapses: 3, difficulty: 8, stability: 1 }); // old trouble only
    await study('hola', { difficulty: 7.5 }); // hard, never lapsed
    await study('die Katze', { difficulty: 4 }, [[now - 40 * DAY, Rating.Again], [now - DAY, Rating.Good]]); // healthy now
    const weak = await call(service, 'get_weak_cards');
    expect(weak).toMatchObject({ deck: null, days: 30, total: 3 });
    expect(weak.cards.map((c: any) => [c.studyItemId, c.score])).toEqual([
      [id('Adiós'), weaknessScore(0, 3, 8, 1)], [id('der Hund'), weaknessScore(2, 1, 6, 10)], [id('hola'), weaknessScore(0, 0, 7.5, 10)],
    ]);
    expect(weak.cards[1]).toMatchObject({ prompt: 'der Hund', answer: 'the dog', recentAgain: 2, difficulty: 6, lapses: 1,
      lastReview: expect.any(String), decks: ['german/grammar'], state: 'review' });
    const lastDay = await call(service, 'get_weak_cards', { days: 1 });
    expect(lastDay.cards.find((c: any) => c.studyItemId === id('der Hund')).recentAgain).toBe(1);
    expect((await call(service, 'get_weak_cards', { days: 60 })).total).toBe(4); // die Katze's old Again counts
    expect((await call(service, 'get_weak_cards', { deckId: await deckId(service, 'german') })).cards.map((c: any) => c.studyItemId)).toEqual([id('der Hund')]);
    expect((await call(service, 'get_weak_cards', { limit: 2 })).cards).toHaveLength(2);
  });

  it('previews the next interval per rating like the HTTP API, in every card tool, without writing anything', async () => {
    // Freeze the clock so the HTTP API and the tool preview the same instant (mid-minute, so the
    // minute-rounded due times are unambiguous). Freeze it BEFORE seeding: new cards are due from the
    // instant they are created, so seeding at the real time and reading at a rounded instant up to
    // 30 s earlier left "der Hund" not yet due whenever the test ran in the second half of a minute.
    const instant = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 30_000);
    vi.useFakeTimers({ toFake: ['Date'], now: instant });
    cleanup.push(async () => vi.useRealTimers());
    const { db, service, id, study } = await setup({ dailyNewLimit: 0, leechThreshold: 1 });
    await study('der Vogel', { due: Date.now() - 2 * DAY, lapses: 1, stability: 12, difficulty: 7.2 }, [[Date.now() - DAY / 2, Rating.Again]]);
    const before = snapshot(db);
    const token = 'preview-secret-'.repeat(3);
    const server = createRecallServer(service, token);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    cleanup.push(() => new Promise(r => server.close(r)));
    const http = await (await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/due?limit=100`,
      { headers: { Authorization: `Bearer ${token}` } })).json() as { items: { studyItemId: string; preview: Record<string, number> }[] };
    const due = await call(service, 'get_due_cards', { limit: 50 });
    const minute = (iso: string) => new Date(iso).getTime();
    for (const key of ['der Vogel', 'der Hund']) {
      const card = due.cards.find((c: any) => c.studyItemId === id(key));
      const preview = http.items.find(i => i.studyItemId === id(key))!.preview;
      for (const rating of ['again', 'hard', 'good', 'easy']) {
        const { in: interval, due: when } = card.next[rating];
        expect(when).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\dZ$/);
        const days = preview[`${rating}Days`];
        // Whole days as the HTTP API reports them; under a day, minutes or hours (where HTTP says 0 or 1).
        if (interval.endsWith('d')) expect(interval).toBe(`${days}d`);
        else expect(days).toBeLessThanOrEqual(1);
        // Same instant: the due time is exactly the scheduler preview behind the HTTP API's days.
        const expected = (await service.query(async c => c.scheduler.previewAll(
          (await c.studyItemRepository.findById(new StudyItemId(id(key))))!.memoryState, instant))).find(p => p.rating === rating)!;
        expect(expected.intervalDays).toBe(days);
        expect(when).toBe(`${expected.nextDue.toISOString().slice(0, 16)}Z`);
        expect(Math.abs(minute(when) - instant.getTime() - days * DAY)).toBeLessThan(DAY / 2 + 60_000);
      }
    }
    const hund = due.cards.find((c: any) => c.studyItemId === id('der Hund')).next;
    expect(Object.values(hund).map((p: any) => p.in).slice(0, 3)).toEqual(['1m', '5m', '10m']); // FSRS learning steps
    const vogel = due.cards.find((c: any) => c.studyItemId === id('der Vogel')).next;
    for (const name of ['get_leeches', 'get_weak_cards']) {
      const card = (await call(service, name)).cards.find((c: any) => c.studyItemId === id('der Vogel'));
      expect(Object.keys(card.next)).toEqual(['again', 'hard', 'good', 'easy']);
      expect(card.next.good.in).toBe(vogel.good.in);
    }
    const searched = (await call(service, 'search_cards', { query: 'vogel' })).cards[0].directions[0];
    expect(searched.next.easy.in).toBe(vogel.easy.in);
    expect(snapshot(db)).toEqual(before);
  });

  it('rejects bad arguments with ToolInputError', async () => {
    const { service } = await setup();
    const bad: [string, Record<string, unknown>][] = [
      ['get_due_cards', { limit: 0 }], ['get_due_cards', { limit: 51 }], ['get_due_cards', { limit: 2.5 }], ['get_due_cards', { limit: '5' }],
      ['get_due_cards', { deck: 'german' }], ['get_due_cards', { deckId: 'german' }], ['get_due_cards', { deckId: 7 }], ['get_due_cards', { deckId: '' }],
      ['get_leeches', { deckId: 'nope' }], ['get_leeches', { threshold: 1 }],
      ['get_study_stats', { deckId: 'x' }], ['list_decks', { limit: 5 }],
      ['search_cards', {}], ['search_cards', { query: 'a' }], ['search_cards', { query: ' á  ' }], ['search_cards', { query: 5 }],
      ['search_cards', { query: 'y'.repeat(201) }], ['search_cards', { query: 'hola', limit: 100 }],
      ['get_weak_cards', { days: 0 }], ['get_weak_cards', { days: 91 }], ['get_weak_cards', { deckId: 'unknown' }],
    ];
    for (const [name, args] of bad) await expect(tool(name).call(service, args), `${name} ${JSON.stringify(args)}`).rejects.toBeInstanceOf(ToolInputError);
    // null means "not given"
    expect((await call(service, 'get_due_cards', { deckId: null, limit: null })).cards).toHaveLength(2);
  });

  it('reading never changes stored state or daily counters', async () => {
    const { db, service, study } = await setup();
    await study('der Hund', { lapses: 4 }, [[Date.now() - DAY, Rating.Again]]);
    // A real review today, so the daily counters exist and must stay as they are.
    const queue = (await service.due()).items;
    await service.review({ operationId: randomUUID(), studyItemId: queue[0].studyItemId, rating: Rating.Good, expectedRevision: queue[0].revision });
    const before = snapshot(db);
    const queueBefore = (await service.due()).items.map(i => [i.studyItemId, i.revision]);
    for (const t of RECALL_TOOLS) {
      const args: Record<string, unknown> = t.name === 'search_cards' ? { query: 'the', limit: 50 } : t.name === 'list_decks' || t.name === 'get_study_stats' ? {} : { limit: 50 };
      await t.call(service, args);
      await t.call(service, args);
    }
    expect(snapshot(db)).toEqual(before);
    expect((await service.due()).items.map(i => [i.studyItemId, i.revision])).toEqual(queueBefore);
  });
});

describe('GetWeakStudyItems', () => {
  it('reads the review log only from the window start and skips new cards', async () => {
    const stores = inMemoryStores();
    const now = new Date('2026-06-01T12:00:00Z');
    const save = (id: string, reps: number, lapses: number, difficulty: number) => stores.studyItems.save(StudyItem.reconstitute(
      new StudyItemId(id), new ConceptId(`c${id}`), Direction.AtoB, new MemoryState(5, difficulty, now, reps, lapses, reps ? now : null)));
    await save('new', 0, 0, 9);
    await save('ok', 4, 0, 3);
    await save('failed', 2, 0, 5);
    await stores.reviews.append(new Review(new StudyItemId('failed'), Rating.Again, new Date(now.getTime() - 3 * DAY)));
    await stores.reviews.append(new Review(new StudyItemId('ok'), Rating.Again, new Date(now.getTime() - 31 * DAY)));
    let windowStart: Date | undefined;
    const findSince = stores.reviews.findSince.bind(stores.reviews);
    stores.reviews.findSince = since => { windowStart = since; return findSince(since); };
    const views = await new GetWeakStudyItems(stores.studyItems, stores.reviews).execute(now, 30);
    expect(views.map(v => [v.studyItemId, v.recentAgain])).toEqual([['failed', 1]]);
    expect(windowStart).toEqual(new Date(now.getTime() - 30 * DAY));
  });
});
