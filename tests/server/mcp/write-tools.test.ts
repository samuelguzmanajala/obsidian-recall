import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RecallDatabase } from '../../../src/server/database';
import { RecallService } from '../../../src/server/service';
import { clientOrigin, createRecallServer } from '../../../src/server/http';
import { RECALL_TOOLS, ToolInputError } from '../../../src/server/mcp/tools';
import { RECALL_WRITE_TOOLS } from '../../../src/server/mcp/write-tools';
import { mcpTools } from '../../../src/server/mcp/configure';
import { INSTRUCTIONS, McpProtocol, WRITE_INSTRUCTIONS } from '../../../src/server/mcp/protocol';
import { StudyItem } from '../../../src/context/study/domain/study-item';
import { StudyItemId } from '../../../src/context/study/domain/study-item-id';
import { Rating } from '../../../src/context/study/domain/rating';
import { Review } from '../../../src/context/study/domain/review';
import { FsrsScheduler } from '../../../src/context/study/infrastructure/fsrs-scheduler';

const MIN = 60_000, H = 3_600_000;
/** Local noon of a fixed day: every test runs on a frozen clock, far from midnight. */
const NOON = new Date(2026, 5, 10, 12, 0, 0).getTime();
const cleanup: (() => Promise<unknown>)[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOON); });
afterEach(async () => { vi.useRealTimers(); for (const f of cleanup.splice(0).reverse()) await f(); });
const at = (ms: number) => vi.setSystemTime(ms);

const NOTE = '---\ntags: german\n---\nder Hund::the dog\ndie Katze::the cat\nder Vogel::the bird\nGuten Morgen:::good morning';

async function setup(settings: Partial<RecallService['settings']> = {}) {
  const db = new RecallDatabase(':memory:');
  cleanup.push(() => db.close());
  const service = new RecallService(db, { shuffleReviews: false, dailyNewLimit: 10, dailyReviewLimit: 0, ...settings });
  await service.note({ operationId: randomUUID(), path: 'German.md', content: NOTE, expectedRevision: 0 });
  const card = async (prompt: string) => (await call(service, 'get_due_cards', { limit: 50 })).cards.find((c: any) => c.prompt === prompt);
  /** A card by its prompt whether or not it is in the queue (search_cards), with its revision. */
  const find = async (prompt: string) => (await call(service, 'search_cards', { query: prompt })).cards.flatMap((c: any) =>
    c.directions.map((d: any) => ({ ...d, prompt: d.prompt === 'sideA' ? c.sideA : c.sideB }))).find((d: any) => d.prompt === prompt);
  const budget = () => service.query(async () => db.stmt('SELECT introduced, reviewed FROM daily_budgets').all().map(r => ({ ...r })));
  const state = (id: string) => service.query(async c => (await c.studyItemRepository.findById(new StudyItemId(id)))!.memoryState);
  const reviews = () => service.query(async () => db.stmt('SELECT seq, study_item_id, rating, timestamp, origin FROM reviews ORDER BY seq').all().map(r => ({ ...r })));
  const changes = () => service.query(async () => db.stmt('SELECT * FROM review_changes ORDER BY id').all().map(r => ({ ...r })));
  /** Records a card by its prompt through record_review, with the revision get_due_cards gives. */
  const record = async (prompt: string, rating: string) => {
    const c = await find(prompt);
    return call(service, 'record_review', { studyItemId: c.studyItemId, rating, revision: c.revision });
  };
  return { db, service, card, find, budget, state, reviews, changes, record };
}
const tools = [...RECALL_TOOLS, ...RECALL_WRITE_TOOLS];
const tool = (name: string) => tools.find(t => t.name === name)!;
async function call(service: RecallService, name: string, args: Record<string, unknown> = {}) {
  const result = await tool(name).call(service, args);
  expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  return result.structuredContent as Record<string, any>;
}
async function refused(service: RecallService, name: string, args: Record<string, unknown>): Promise<string> {
  const error = await tool(name).call(service, args).then(() => null, e => e);
  expect(error, `${name} ${JSON.stringify(args)} should fail`).toBeInstanceOf(ToolInputError);
  return error.message;
}
/** The card's state if its whole history were replayed from scratch. */
async function replayed(service: RecallService, studyItemId: string) {
  return service.query(async c => {
    const item = (await c.studyItemRepository.findById(new StudyItemId(studyItemId)))!;
    const fresh = StudyItem.create(item.id, item.conceptId, item.direction);
    fresh.replay(await c.reviewLog.findByStudyItemId(item.id), new FsrsScheduler());
    return fresh.memoryState;
  });
}
async function httpApi(service: RecallService) {
  const token = 'write-tools-test-token-'.repeat(2);
  const server = createRecallServer(service, token);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  return async (path: string, body?: unknown, headers: Record<string, string> = {}, auth = token) => {
    const res = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${auth}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
}

describe('safety switch', () => {
  it('off (default): exactly the six read-only tools and the read-only instructions; write tools are unknown', async () => {
    const { service } = await setup();
    expect(mcpTools(false)).toBe(RECALL_TOOLS);
    expect(mcpTools(false).map(t => t.name)).toEqual(['list_decks', 'get_due_cards', 'get_weak_cards', 'get_leeches', 'search_cards', 'get_study_stats']);
    const mcp = new McpProtocol(service, mcpTools(false));
    expect((await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }))!.result).toMatchObject({ instructions: INSTRUCTIONS });
    const list = (await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))!.result as { tools: { name: string }[] };
    expect(list.tools.map(t => t.name)).toEqual(RECALL_TOOLS.map(t => t.name));
    const call = await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'record_review', arguments: {} } });
    expect(call!.error).toMatchObject({ code: -32602, message: 'Unknown tool: record_review' });
  });

  it('on: the six plus seven write tools, the write instructions, and no write tool claims to be read-only or destructive', async () => {
    const { service } = await setup();
    const mcp = new McpProtocol(service, mcpTools(true));
    expect((await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))!.result).toMatchObject({ instructions: WRITE_INSTRUCTIONS });
    const list = (await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))!.result as { tools: { name: string; annotations: Record<string, boolean> }[] };
    expect(list.tools.map(t => t.name)).toEqual([...RECALL_TOOLS.map(t => t.name), 'record_review', 'list_recent_reviews', 'amend_review',
      'remove_review', 'revert_review_change', 'propose_card', 'list_card_proposals']);
    for (const name of ['record_review', 'amend_review', 'remove_review', 'revert_review_change', 'propose_card']) {
      expect(list.tools.find(t => t.name === name)!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    }
    for (const name of ['list_recent_reviews', 'list_card_proposals']) expect(list.tools.find(t => t.name === name)!.annotations.readOnlyHint).toBe(true);
    for (const t of RECALL_WRITE_TOOLS) {
      expect(t.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(t.description.length).toBeGreaterThan(150);
    }
    expect(WRITE_INSTRUCTIONS).toMatch(/only then call record_review/);
    expect(WRITE_INSTRUCTIONS).toMatch(/accepts it later in Obsidian/);
  });
});

describe('record_review', () => {
  it('records through the HTTP path: schedule, origin, prior, counters and revision; returns the real next due', async () => {
    const { service, card, budget, state, reviews } = await setup();
    const hund = await card('der Hund');
    expect(hund.revision).toBe(1);
    const result = await call(service, 'record_review', { studyItemId: hund.studyItemId, rating: 'good', revision: hund.revision });
    const after = await state(hund.studyItemId);
    expect(result).toEqual({ reviewId: 1, studyItemId: hund.studyItemId, prompt: 'der Hund', rating: 'good',
      due: `${after.due.toISOString().slice(0, 16)}Z`, in: hund.next.good.in, revision: 2 });
    expect(after.reps).toBe(1);
    expect(await reviews()).toEqual([{ seq: 1, study_item_id: hund.studyItemId, rating: 'good', timestamp: NOON, origin: 'mcp' }]);
    expect(await budget()).toEqual([{ introduced: 1, reviewed: 0 }]);
    // The other clients see the new revision.
    const queue = (await service.due()).items;
    expect(queue.find(i => i.studyItemId === hund.studyItemId)).toBeUndefined(); // no longer due
    const prior = await service.query(async c => (await c.reviewLog.findLogged(1))!.review.prior);
    expect(prior!.reps).toBe(0);
  });

  it('a retried call (same card, revision and rating) returns the same result and records nothing twice', async () => {
    const { service, card, budget, reviews } = await setup();
    const katze = await card('die Katze');
    const args = { studyItemId: katze.studyItemId, rating: 'again', revision: katze.revision };
    const first = await call(service, 'record_review', args);
    at(NOON + 5 * MIN); // the Again card is due again by now: only the receipt stops a double review
    const retry = await call(service, 'record_review', args);
    expect({ ...retry, in: first.in }).toEqual(first);
    expect(await reviews()).toHaveLength(1);
    expect(await budget()).toEqual([{ introduced: 1, reviewed: 0 }]);
    // Same revision, other rating: refused, pointing to amend_review.
    expect(await refused(service, 'record_review', { ...args, rating: 'easy' })).toMatch(/already rated.*amend_review/);
    // A genuine second review uses the new revision.
    const again = await card('die Katze');
    expect(again.revision).toBe(2);
    expect((await call(service, 'record_review', { studyItemId: katze.studyItemId, rating: 'good', revision: 2 })).reviewId).toBe(2);
    expect(await budget()).toEqual([{ introduced: 1, reviewed: 1 }]);
  });

  it('refuses stale revisions, cards that are not due, unknown cards and bad arguments', async () => {
    const { service, card, record } = await setup();
    const hund = await card('der Hund');
    expect(await refused(service, 'record_review', { studyItemId: hund.studyItemId, rating: 'good', revision: 0 })).toMatch(/get_due_cards/);
    await record('der Hund', 'easy');
    expect(await refused(service, 'record_review', { studyItemId: hund.studyItemId, rating: 'good', revision: 2 })).toMatch(/no longer due/);
    expect(await refused(service, 'record_review', { studyItemId: 'nope', rating: 'good', revision: 0 })).toMatch(/no longer exists/);
    for (const args of [{}, { studyItemId: hund.studyItemId, rating: 'good' }, { studyItemId: hund.studyItemId, rating: 'ok', revision: 1 },
      { studyItemId: hund.studyItemId, rating: 'good', revision: -1 }, { studyItemId: hund.studyItemId, rating: 'good', revision: 1.5 },
      { studyItemId: 5, rating: 'good', revision: 1 }, { studyItemId: hund.studyItemId, rating: 'good', revision: 1, operationId: 'x' }]) {
      await refused(service, 'record_review', args);
    }
  });

  it('respects the daily limits like the apps', async () => {
    const { service, record, card, find } = await setup({ dailyNewLimit: 1 });
    const katze = await find('die Katze');
    await record('der Hund', 'good');
    expect(await card('die Katze')).toBeUndefined(); // not offered any more today
    expect(await refused(service, 'record_review', { studyItemId: katze.studyItemId, rating: 'good', revision: katze.revision })).toMatch(/Daily limit/);
  });
});

describe('reviews from every client, and their corrections', () => {
  it('labels HTTP reviews by client and lists reviews of any origin, newest first, within the window', async () => {
    expect(clientOrigin('okhttp/4.12.0')).toBe('android');
    expect(clientOrigin('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 obsidian/1.8.9 Chrome/130 Electron/33')).toBe('obsidian');
    expect(clientOrigin(undefined)).toBe('api');
    const { service, record } = await setup();
    const http = await httpApi(service);
    // A review recorded before origins were kept.
    const vogel = (await service.due()).items.find(i => i.sideA === 'der Vogel')!;
    await service.query(async c => c.reviewLog.append(new Review(new StudyItemId(vogel.studyItemId), Rating.Hard, new Date(NOON - 3 * H))));
    at(NOON + MIN);
    const queue = (await http('/due?limit=50')).body.items;
    const katze = queue.find((i: any) => i.sideA === 'die Katze');
    expect((await http('/reviews', { reviews: [{ operationId: 'a1', studyItemId: katze.studyItemId, rating: 'again', expectedRevision: katze.revision }] }, { 'User-Agent': 'okhttp/4.12.0' })).body).toEqual({ applied: 1, errors: [] });
    at(NOON + 2 * MIN);
    const morgen = queue.find((i: any) => i.sideA === 'Guten Morgen');
    await http('/reviews', { reviews: [{ operationId: 'o1', studyItemId: morgen.studyItemId, rating: 'easy', expectedRevision: morgen.revision }] }, { 'User-Agent': 'obsidian/1.8.9' });
    at(NOON + 3 * MIN);
    await record('der Hund', 'good');
    const list = await call(service, 'list_recent_reviews');
    expect(list.hours).toBe(48);
    expect(list.reviews.map((r: any) => [r.prompt, r.rating, r.origin])).toEqual([
      ['der Hund', 'good', 'mcp'], [morgen.voiceQuestion, 'easy', 'obsidian'], // whichever direction the queue offered
      ['die Katze', 'again', 'android'], ['der Vogel', 'hard', 'unknown']]);
    expect(list.reviews[0]).toEqual({ reviewId: 4, studyItemId: expect.any(String), prompt: 'der Hund', answer: 'the dog', rating: 'good',
      at: `${new Date(NOON + 3 * MIN).toISOString().slice(0, 16)}Z`, origin: 'mcp' });
    expect(list.changes).toEqual([]);
    expect((await call(service, 'list_recent_reviews', { hours: 1, limit: 2 })).reviews.map((r: any) => r.prompt)).toEqual(['der Hund', expect.any(String)]);
    expect((await call(service, 'list_recent_reviews', { hours: 1 })).reviews).toHaveLength(3);
    for (const args of [{ hours: 0 }, { hours: 49 }, { limit: 51 }, { days: 1 }]) await refused(service, 'list_recent_reviews', args);
  });

  it('amend_review: recomputes the card, audits the change, bumps the revision, keeps the counters; same rating is a no-op', async () => {
    const { service, record, state, budget, changes, card } = await setup();
    const { reviewId, studyItemId } = await record('der Hund', 'easy');
    const http = await httpApi(service);
    const revisionBefore = (await service.query(async () => service.revisionOf(studyItemId)));
    at(NOON + 10 * MIN);
    const amended = await call(service, 'amend_review', { reviewId, rating: 'hard' });
    const after = await state(studyItemId);
    expect(amended).toEqual({ changeId: 1, reviewId, studyItemId, prompt: 'der Hund', action: 'amend', from: 'easy', to: 'hard',
      due: `${after.due.toISOString().slice(0, 16)}Z`, in: expect.stringMatching(/^\d+[mhd]$|^now$/) });
    expect(after).toEqual(await replayed(service, studyItemId));
    expect(await service.query(async () => service.revisionOf(studyItemId))).toBe(revisionBefore + 1);
    expect(await budget()).toEqual([{ introduced: 1, reviewed: 0 }]);
    expect(await changes()).toEqual([{ id: 1, review_id: reviewId, study_item_id: studyItemId, review_timestamp: NOON, review_origin: 'mcp', action: 'amend',
      old_rating: 'easy', new_rating: 'hard', prior: null, reverts: null, at: NOON + 10 * MIN, origin: 'mcp' }]);
    // A client still holding the old revision is told to refresh.
    const stale = await http('/reviews', { reviews: [{ operationId: 'late', studyItemId, rating: 'good', expectedRevision: revisionBefore }] });
    expect(stale.body.errors[0]).toMatchObject({ status: 409 });
    expect(await call(service, 'amend_review', { reviewId, rating: 'hard' })).toMatchObject({ changeId: null, action: null, from: 'hard', to: 'hard' });
    expect(await changes()).toHaveLength(1);
    const list = await call(service, 'list_recent_reviews');
    expect(list.reviews[0]).toMatchObject({ reviewId, rating: 'hard', originalRating: 'easy' });
    expect(list.changes).toEqual([{ changeId: 1, reviewId, prompt: 'der Hund', action: 'amend', from: 'easy', to: 'hard', at: expect.any(String) }]);
    for (const args of [{ reviewId }, { reviewId: 0, rating: 'good' }, { reviewId: '1', rating: 'good' }, { reviewId, rating: 'meh' }]) await refused(service, 'amend_review', args);
    expect(await refused(service, 'amend_review', { reviewId: 99, rating: 'good' })).toMatch(/not found/);
  });

  it('amending an earlier review re-applies the later ones (any origin)', async () => {
    const { service, record, state } = await setup();
    const first = await record('die Katze', 'good');
    at(NOON + 15 * MIN);
    const second = await record('die Katze', 'again');
    at(NOON + 30 * MIN);
    await record('die Katze', 'good');
    await call(service, 'amend_review', { reviewId: first.reviewId, rating: 'again' });
    expect(await state(first.studyItemId)).toEqual(await replayed(service, first.studyItemId));
    await call(service, 'remove_review', { reviewId: second.reviewId });
    expect(await state(first.studyItemId)).toEqual(await replayed(service, first.studyItemId));
  });

  it('only reviews from the last 2 days can be corrected', async () => {
    const { service, record } = await setup();
    const { reviewId } = await record('der Hund', 'good');
    at(NOON + 48 * H + MIN);
    expect(await refused(service, 'amend_review', { reviewId, rating: 'hard' })).toMatch(/last 2 days/);
    expect(await refused(service, 'remove_review', { reviewId })).toMatch(/last 2 days/);
    expect((await call(service, 'list_recent_reviews')).reviews).toEqual([]);
  });

  it('remove_review: gives back today\'s allowance and makes the card due again; retry and revert', async () => {
    const { service, record, state, budget, changes, reviews } = await setup({ dailyNewLimit: 2 });
    const morgen = await record('der Vogel', 'good');
    const stateAfterReview = await state(morgen.studyItemId);
    await record('der Hund', 'good');
    expect(await budget()).toEqual([{ introduced: 2, reviewed: 0 }]);
    expect((await call(service, 'get_due_cards')).newLeftToday).toBe(0);
    at(NOON + 5 * MIN);
    const removed = await call(service, 'remove_review', { reviewId: morgen.reviewId });
    expect(removed).toMatchObject({ changeId: 1, reviewId: morgen.reviewId, action: 'remove', from: 'good', to: null, in: 'now' });
    expect(await budget()).toEqual([{ introduced: 1, reviewed: 0 }]);
    expect(await state(morgen.studyItemId)).toMatchObject({ reps: 0, lastReview: null });
    const due = await call(service, 'get_due_cards');
    expect(due.newLeftToday).toBe(1);
    expect(due.newCardsDue).toBe(3); // die Katze, one direction of Guten Morgen, and der Vogel again
    expect((await changes())[0]).toMatchObject({ action: 'remove', old_rating: 'good', new_rating: null, prior: expect.stringContaining('"reps":0') });
    // Retried: nothing more happens.
    expect(await call(service, 'remove_review', { reviewId: morgen.reviewId })).toMatchObject({ changeId: 1, alreadyDone: true });
    expect(await budget()).toEqual([{ introduced: 1, reviewed: 0 }]);
    // Reverted: the same review is back, under its id, with the same state and allowance.
    const restored = await call(service, 'revert_review_change', { changeId: 1 });
    expect(restored).toMatchObject({ changeId: 2, reviewId: morgen.reviewId, action: 'restore', from: null, to: 'good' });
    expect(await state(morgen.studyItemId)).toEqual(stateAfterReview);
    expect((await reviews()).find(r => r.seq === morgen.reviewId)).toMatchObject({ rating: 'good', timestamp: NOON, origin: 'mcp' });
    expect(await budget()).toEqual([{ introduced: 2, reviewed: 0 }]);
    expect(await call(service, 'revert_review_change', { changeId: 1 })).toMatchObject({ changeId: 2, alreadyDone: true });
    const list = await call(service, 'list_recent_reviews');
    expect(list.changes.map((c: any) => [c.changeId, c.action, c.reverts ?? null, c.revertedBy ?? null])).toEqual([[2, 'restore', 1, null], [1, 'remove', null, 2]]);
  });

  it('removing the first review of a card studied twice today moves the second one to "introduced"', async () => {
    const { service, record, budget } = await setup();
    const first = await record('die Katze', 'again');
    at(NOON + 2 * MIN);
    await record('die Katze', 'good');
    expect(await budget()).toEqual([{ introduced: 1, reviewed: 1 }]);
    await call(service, 'remove_review', { reviewId: first.reviewId });
    expect(await budget()).toEqual([{ introduced: 1, reviewed: 0 }]);
    await call(service, 'revert_review_change', { changeId: 1 });
    expect(await budget()).toEqual([{ introduced: 1, reviewed: 1 }]);
  });

  it('revert_review_change: an amend goes back; only the latest change of a review can be undone; bad ids', async () => {
    const { service, record, state, changes } = await setup();
    const { reviewId, studyItemId } = await record('der Vogel', 'easy');
    const original = await state(studyItemId);
    await call(service, 'amend_review', { reviewId, rating: 'hard' });
    await call(service, 'amend_review', { reviewId, rating: 'again' });
    expect(await refused(service, 'revert_review_change', { changeId: 1 })).toMatch(/changed again.*change 2/);
    expect(await call(service, 'revert_review_change', { changeId: 2 })).toMatchObject({ changeId: 3, action: 'amend', from: 'again', to: 'hard' });
    expect(await refused(service, 'revert_review_change', { changeId: 1 })).toMatch(/revert that change first/);
    await call(service, 'revert_review_change', { changeId: 3 }); // redo: back to again
    expect((await changes()).map(c => [c.action, c.old_rating, c.new_rating, c.reverts])).toEqual([
      ['amend', 'easy', 'hard', null], ['amend', 'hard', 'again', null], ['amend', 'again', 'hard', 2], ['amend', 'hard', 'again', 3]]);
    await call(service, 'amend_review', { reviewId, rating: 'easy' });
    expect(await state(studyItemId)).toEqual(original);
    expect(await refused(service, 'revert_review_change', { changeId: 99 })).toMatch(/not found/);
    for (const args of [{}, { changeId: 0 }, { changeId: 'x' }, { changeId: 1, reviewId: 1 }]) await refused(service, 'revert_review_change', args);
  });
});

describe('card proposals', () => {
  it('propose_card stores a pending proposal (never a card), deduplicates retries and refuses existing cards', async () => {
    const { service, db } = await setup();
    const concepts = () => service.query(async () => db.stmt('SELECT COUNT(*) AS n FROM concepts').get()!.n);
    const cardsBefore = await concepts();
    const args = { sideA: 'der Schmetterling', sideB: 'the butterfly', directionality: 'bidirectional', deck: '#german', context: 'confused with die Motte' };
    const proposed = await call(service, 'propose_card', args);
    expect(proposed).toEqual({ proposalId: 1, sideA: 'der Schmetterling', sideB: 'the butterfly', directionality: 'bidirectional', deck: 'german',
      context: 'confused with die Motte', status: 'pending', createdAt: `${new Date(NOON).toISOString().slice(0, 16)}Z`, deckExists: true });
    expect(await call(service, 'propose_card', { ...args, sideA: 'Der  SCHMETTERLING ', deck: null })).toMatchObject({ proposalId: 1, duplicate: true });
    expect(await call(service, 'propose_card', { sideA: 'die Motte', sideB: 'the moth', directionality: 'unidirectional', deck: 'german/insects' }))
      .toMatchObject({ proposalId: 2, deck: 'german/insects', deckExists: false });
    expect(await refused(service, 'propose_card', { sideA: 'the dog', sideB: 'der hund', directionality: 'bidirectional' })).toMatch(/already exists.*studyItemId/);
    expect(await concepts()).toBe(cardsBefore);
    const bad = [{ sideA: 'a', sideB: 'b' }, { sideA: '', sideB: 'b', directionality: 'bidirectional' }, { sideA: 'a::b', sideB: 'b', directionality: 'bidirectional' },
      { sideA: 'a\nb', sideB: 'b', directionality: 'bidirectional' }, { sideA: 'a', sideB: 'b', directionality: 'both' },
      { sideA: 'a', sideB: 'b', directionality: 'bidirectional', deck: 'my deck' }, { sideA: 'a', sideB: 'b'.repeat(1001), directionality: 'bidirectional' },
      { sideA: 'a', sideB: 'b', directionality: 'bidirectional', tags: 'x' }];
    for (const args of bad) await refused(service, 'propose_card', args);
    const pending = await call(service, 'list_card_proposals');
    expect(pending).toMatchObject({ status: 'pending', total: 2 });
    expect(pending.proposals.map((p: any) => p.proposalId)).toEqual([2, 1]);
    expect((await call(service, 'list_card_proposals', { limit: 1 })).proposals).toHaveLength(1);
    expect((await call(service, 'list_card_proposals', { status: 'accepted' })).total).toBe(0);
    await refused(service, 'list_card_proposals', { status: 'open' });
  });

  it('private HTTP API: list, accept and dismiss, idempotent, with the usual auth and errors', async () => {
    const { service } = await setup();
    const http = await httpApi(service);
    await call(service, 'propose_card', { sideA: 'die Biene', sideB: 'the bee', directionality: 'bidirectional', deck: 'german' });
    await call(service, 'propose_card', { sideA: 'die Ameise', sideB: 'the ant', directionality: 'unidirectional' });
    const list = await http('/proposals');
    expect(list).toEqual({ status: 200, body: { proposals: [
      { id: 1, sideA: 'die Biene', sideB: 'the bee', directionality: 'bidirectional', deck: 'german', context: null, status: 'pending', origin: 'mcp',
        createdAt: new Date(NOON).toISOString(), decidedAt: null, notePath: null },
      { id: 2, sideA: 'die Ameise', sideB: 'the ant', directionality: 'unidirectional', deck: null, context: null, status: 'pending', origin: 'mcp',
        createdAt: new Date(NOON).toISOString(), decidedAt: null, notePath: null },
    ] } });
    at(NOON + MIN);
    const accepted = await http('/proposals/accept', { id: 1, notePath: 'German/Insects.md' });
    expect(accepted).toEqual({ status: 200, body: { proposal: { ...list.body.proposals[0], status: 'accepted', decidedAt: new Date(NOON + MIN).toISOString(), notePath: 'German/Insects.md' } } });
    at(NOON + 2 * MIN);
    expect(await http('/proposals/accept', { id: 1, notePath: 'Other.md' })).toEqual(accepted); // retried: unchanged
    expect((await http('/proposals/dismiss', { id: 1 })).status).toBe(409);
    expect((await http('/proposals/dismiss', { id: 2 })).body.proposal).toMatchObject({ status: 'dismissed', notePath: null });
    expect((await http('/proposals/dismiss', { id: 2 })).status).toBe(200);
    expect((await http('/proposals/accept', { id: 2 })).status).toBe(409);
    expect((await http('/proposals')).body.proposals).toEqual([]);
    expect((await http('/proposals?status=all')).body.proposals.map((p: any) => p.status)).toEqual(['accepted', 'dismissed']);
    expect((await http('/proposals?status=accepted')).body.proposals.map((p: any) => p.id)).toEqual([1]);
    expect((await http('/proposals?status=nope')).status).toBe(400);
    expect((await http('/proposals/accept', { id: 99 })).status).toBe(404);
    for (const body of [{}, { id: '1' }, { id: 0 }, { id: 1.5 }, { id: 1, notePath: 5 }]) expect((await http('/proposals/accept', body)).status, JSON.stringify(body)).toBe(400);
    expect((await http('/proposals', undefined, {}, 'wrong-token')).status).toBe(401);
    // Accepting never creates a card: the vault stays the only source.
    expect((await call(service, 'search_cards', { query: 'Biene' })).total).toBe(0);
    // MCP sees the decisions (so it does not propose them again).
    expect((await call(service, 'list_card_proposals', { status: 'all' })).proposals.map((p: any) => [p.proposalId, p.status])).toEqual([[2, 'dismissed'], [1, 'accepted']]);
    // A dismissed proposal may be proposed again (only pending ones deduplicate).
    expect(await call(service, 'propose_card', { sideA: 'die Ameise', sideB: 'the ant', directionality: 'unidirectional' })).toMatchObject({ proposalId: 3 });
  });
});
