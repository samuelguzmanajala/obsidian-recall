import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RecallDatabase } from '../../src/server/database';
import { RecallService } from '../../src/server/service';
import { createRecallServer } from '../../src/server/http';
import { Rating } from '../../src/context/study/domain/rating';
import { RemoteClient } from '../../src/app/backend/remote-client';
import { DEFAULT_SETTINGS } from '../../src/app/backend/recall-settings';
import { RemoteNoteSync } from '../../src/app/backend/remote-note-sync';
import { TtsCache } from '../../src/app/backend/voice-api/tts-cache';
import type { ServerAudio } from '../../src/server/audio';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
function setup(path = ':memory:') {
  const db = new RecallDatabase(path);
  cleanup.push(() => db.close());
  return new RecallService(db, { shuffleReviews: false, dailyNewLimit: 0 });
}
async function seed(service: RecallService, content = 'Question::Answer') {
  await service.note({ operationId: randomUUID(), path: 'Test.md', content, expectedRevision: 0 });
  return (await service.due()).items[0];
}
function command(item: Awaited<ReturnType<typeof seed>>) {
  return { operationId: randomUUID(), studyItemId: item.studyItemId, rating: Rating.Good, expectedRevision: item.revision };
}
async function serve(service: RecallService, audio?: ServerAudio) {
  const token = 'test-secret-'.repeat(4);
  const server = createRecallServer(service, token, audio);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, token, client: new RemoteClient({ ...structuredClone(DEFAULT_SETTINGS), backend: { url, token, enabled: true, syncNotes: true } }) };
}

describe('standalone backend', () => {
  it('runs the real Obsidian HTTP client without Obsidian or vault storage', async () => {
    const service = setup();
    await seed(service);
    const { client } = await serve(service);
    const [item] = await client.getDueStudyItems.execute();
    expect(item.due).toBeInstanceOf(Date);
    expect(item.preview?.goodDays).toBeDefined();
    expect(client.vaultSync.findFileByConceptId(item.conceptId)?.filePath).toBe('Test.md');
    await client.reviewStudyItem.execute({ studyItemId: item.studyItemId, rating: Rating.Good, expectedRevision: item.revision });
    expect((await client.getStudyStats.execute()).reviewsToday).toBe(1);
  });
  it('applies a duplicated command exactly once, including simultaneous retries', async () => {
    const service = setup();
    const cmd = command(await seed(service));
    const results = await Promise.all(Array.from({ length: 10 }, () => service.review(cmd)));
    expect(results.every(r => JSON.stringify(r) === JSON.stringify(results[0]))).toBe(true);
    expect(await service.query(async c => (await c.reviewLog.findAll()).length)).toBe(1);
    await expect(service.review({ ...cmd, rating: Rating.Easy })).rejects.toMatchObject({ status: 409 });
  });
  it('rejects the stale device instead of applying two reviews', async () => {
    const service = setup();
    const item = await seed(service);
    const results = await Promise.allSettled([service.review(command(item)), service.review(command(item))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
  });
  it('rolls back state, review log and idempotency receipt together', async () => {
    const service = setup();
    const cmd = command(await seed(service));
    service.db.sql.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON operations BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
    await expect(service.review(cmd)).rejects.toThrow('test failure');
    expect(await service.query(async c => (await c.reviewLog.findAll()).length)).toBe(0);
    service.db.sql.exec('DROP TRIGGER reject_receipt');
    await service.review(cmd);
    expect(await service.query(async c => (await c.reviewLog.findAll()).length)).toBe(1);
  });
  it('retains reviews and retry receipts across restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recall-backend-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'test.sqlite');
    const first = new RecallService(new RecallDatabase(path));
    const cmd = command(await seed(first));
    const result = await first.review(cmd);
    await first.db.close();
    const next = setup(path);
    expect(await next.review(cmd)).toEqual(result);
    expect(await next.query(async c => (await c.reviewLog.findAll()).length)).toBe(1);
  });
  it('rejects legacy reviews with no concurrency metadata', async () => {
    const service = setup();
    const item = await seed(service);
    await expect(service.review({ studyItemId: item.studyItemId, rating: 'good' })).rejects.toMatchObject({ status: 400 });
  });
  it('protects note edits, tombstones and stale queued cards', async () => {
    const service = setup();
    const item = await seed(service);
    await service.note({ operationId: randomUUID(), path: 'Test.md', content: 'Intro\nQuestion::Answer', expectedRevision: 1 });
    await expect(service.review(command(item))).rejects.toMatchObject({ status: 409 });
    await expect(service.note({ operationId: randomUUID(), path: 'Test.md', content: 'Stale::Content', expectedRevision: 1 })).rejects.toMatchObject({ status: 409 });
    await service.note({ operationId: randomUUID(), path: 'Test.md', content: null, expectedRevision: 2 });
    expect((await service.due()).items).toHaveLength(0);
    await expect(service.note({ operationId: randomUUID(), path: 'Test.md', content: 'Question::Answer', expectedRevision: 0 })).rejects.toMatchObject({ status: 409 });
    expect((await service.notes()).notes[0]).toMatchObject({ deleted: true, revision: 3 });
  });
  it('renames atomically while preserving card IDs and scheduling', async () => {
    const service = setup();
    const item = await seed(service);
    await service.review(command(item));
    const before = await service.query(async c => c.studyItemRepository.findAll());
    const cmd = { operationId: randomUUID(), path: 'Test.md', newPath: 'Folder/New.md', expectedRevision: 1 };
    await service.renameNote(cmd);
    await service.renameNote(cmd);
    const after = await service.query(async c => c.studyItemRepository.findAll());
    expect(after).toEqual(before);
    expect(await service.query(async c => c.vaultSync!.findFileByConceptId(item.conceptId))).toMatchObject({ filePath: 'Folder/New.md' });
  });
  it('does not let a new publisher overwrite a conflicting server note', async () => {
    const service = setup();
    await seed(service);
    const { client } = await serve(service);
    const sync = new RemoteNoteSync(client, {}, () => {});
    await expect(sync.publish('Test.md', 'Different::Content')).rejects.toMatchObject({ status: 409 });
    await sync.publish('Test.md', 'Question::Answer');
    await sync.publish('Test.md', 'Updated::Content');
    expect((await service.due()).items[0].sideA).toBe('Updated');
  });
  it('keeps the same decision after a lost HTTP acknowledgement', async () => {
    const service = setup();
    await seed(service);
    const { client } = await serve(service);
    const [item] = await client.getDueStudyItems.execute();
    const transport = (client as unknown as { transport: typeof fetch });
    const original = transport.transport;
    let loseResponse = true;
    transport.transport = async (...args) => {
      const response = await original(...args);
      if (loseResponse && args[1]?.method === 'POST') { loseResponse = false; throw new Error('Connection lost'); }
      return response;
    };
    const cmd = { studyItemId: item.studyItemId, rating: Rating.Good, expectedRevision: item.revision };
    await expect(client.reviewStudyItem.execute(cmd)).rejects.toThrow('Connection lost');
    await client.reviewStudyItem.execute({ ...cmd, rating: Rating.Easy });
    const reviews = await service.query(c => c.reviewLog.findAll());
    expect(reviews).toHaveLength(1);
    expect(reviews[0].rating).toBe(Rating.Good);
  });
  it('requires auth and validates requests without exposing internal errors', async () => {
    const { url, token } = await serve(setup());
    expect((await fetch(`${url}/api/v1/health`)).status).toBe(200);
    expect((await fetch(`${url}/api/v1/decks`)).status).toBe(401);
    const headers = { Authorization: `Bearer ${token}` };
    expect((await fetch(`${url}/api/v1/due?limit=NaN`, { headers })).status).toBe(400);
    expect((await fetch(`${url}/api/v1/notes`, { headers, method: 'POST', body: '{' })).status).toBe(400);
    expect((await fetch(`${url}/api/v1/notes`, { headers, method: 'POST', body: JSON.stringify({ operationId: 'x', path: '../escape.md', content: '', expectedRevision: 0 }) })).status).toBe(400);
  });
  it('enforces daily limits globally at submission, including exhaustion at zero', async () => {
    const unlimited = setup();
    const first = await seed(unlimited);
    await unlimited.note({ operationId: randomUUID(), path: 'Second.md', content: 'Other::Answer', expectedRevision: 0 });
    const second = (await unlimited.due()).items.find(i => i.studyItemId !== first.studyItemId)!;
    const limited = new RecallService(unlimited.db, { dailyNewLimit: 1, shuffleReviews: false });
    const results = await Promise.allSettled([limited.review(command(first)), limited.review(command(second))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await limited.due()).items.filter(i => i.reps === 0)).toHaveLength(0);
  });
  it('does not delete a shared card when removing just one source note', async () => {
    const service = setup();
    const item = await seed(service);
    await service.note({ operationId: randomUUID(), path: 'Duplicate.md', content: 'Question::Answer', expectedRevision: 0 });
    await service.note({ operationId: randomUUID(), path: 'Test.md', content: null, expectedRevision: 1 });
    expect((await service.due()).items[0].studyItemId).toBe(item.studyItemId);
    expect((await service.due()).items[0].source?.filePath).toBe('Duplicate.md');
  });
  it('serializes two different note edits and commits only one revision', async () => {
    const service = setup();
    await seed(service);
    const results = await Promise.allSettled(['A::One', 'B::Two'].map(content => service.note({
      operationId: randomUUID(), path: 'Test.md', content, expectedRevision: 1,
    })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await service.notes()).notes[0].revision).toBe(2);
  });
  it('does not hold a database transaction during speech generation', async () => {
    const service = setup();
    const item = await seed(service);
    let started!: () => void;
    let release!: () => void;
    const generating = new Promise<void>(r => { started = r; });
    const unblock = new Promise<void>(r => { release = r; });
    const cache = new TtsCache({ read: async () => null, write: async () => {} }, {
      isConfigured: () => true,
      synthesize: async () => { started(); await unblock; return Buffer.from('test-mp3'); },
    });
    const { url, token } = await serve(service, { cache, rewriter: null });
    const response = fetch(`${url}/api/v1/audio/${item.studyItemId}/question`, { headers: { Authorization: `Bearer ${token}` } });
    await generating;
    try { await service.review(command(item)); } finally { release(); }
    const audio = await response;
    expect(audio.headers.get('content-type')).toBe('audio/mpeg');
    expect(await audio.text()).toBe('test-mp3');
  });
  it('rejects oversized JSON before parsing it', async () => {
    const { url, token } = await serve(setup());
    const response = await fetch(`${url}/api/v1/notes`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: 'x'.repeat(2_100_001),
    });
    expect(response.status).toBe(413);
  });
  it('reindexes published notes when server tag filters change without erasing history', async () => {
    const service = setup();
    const item = await seed(service, '---\ntags: [German]\n---\nQuestion::Answer');
    await service.review(command(item));
    await new RecallService(service.db, { flashcardTags: ['English'] }).reindexIfTagsChanged();
    expect(await service.query(async c => (await c.studyItemRepository.findAll()).length)).toBe(0);
    await new RecallService(service.db, { flashcardTags: ['German'] }).reindexIfTagsChanged();
    const items = await service.query(c => c.studyItemRepository.findAll());
    expect(items[0].id.value).toBe(item.studyItemId);
    expect(items[0].memoryState.reps).toBe(1);
  });
});
