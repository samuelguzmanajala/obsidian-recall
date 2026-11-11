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
import { DEFAULT_SETTINGS } from '../../src/app/backend/plugin-settings';
import { RemoteNoteSync } from '../../src/app/backend/remote-note-sync';
import { TtsCache } from '../../src/server/audio/tts-cache';
import type { ServerAudio } from '../../src/server/audio/configure-audio';

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
  it('does not grow a conflicted journal when a full vault scan sees the same content repeatedly', async () => {
    const service = setup(); const { client } = await serve(service);
    let jobs: any[] = [];
    const sync = new RemoteNoteSync(client, {}, () => {}, {
      load: () => structuredClone(jobs), save: next => { jobs = structuredClone(next); },
    });
    await sync.publish('Test.md', 'Q::Base');
    await service.note({ operationId: randomUUID(), path: 'Test.md', content: 'Q::Other device', expectedRevision: 1 });
    await expect(sync.publish('Test.md', 'Q::Local')).rejects.toMatchObject({ status: 409 });
    for (let i = 0; i < 3; i++) await sync.stageCurrent('Test.md', 'Q::Local');
    expect(sync.pendingCount).toBe(1);
    expect(jobs).toHaveLength(1);
    await sync.stageCurrent('Test.md', 'Q::Latest local');
    expect(sync.pendingCount).toBe(2);
  });
  it('preserves an edit appended while checking an already-applied queued prefix', async () => {
    const service = setup(); const { client } = await serve(service);
    const sync = new RemoteNoteSync(client, {}, () => {});
    await sync.publish('Test.md', 'Q::Base');
    await service.note({ operationId: randomUUID(), path: 'Test.md', content: 'Q::Remote', expectedRevision: 1 });
    await expect(sync.publish('Test.md', 'Q::Stale')).rejects.toThrow();
    await sync.stageCurrent('Test.md', 'Q::Remote');
    const request = client.request.bind(client);
    let injected = false;
    client.request = async <T>(path: string, body?: unknown): Promise<T> => {
      const result = await request<T>(path, body);
      if (path === '/notes' && body === undefined && !injected) {
        injected = true;
        // Mutates the unprepared last job while reconcileConflict awaits metadata.
        await sync.stageCurrent('Test.md', 'Q::Newest local');
      }
      return result;
    };
    await expect(sync.retry()).rejects.toThrow();
    expect(sync.pendingCount).toBe(2);
    expect((await service.due()).items[0].sideB).toBe('Remote');
    await sync.resolveWithLocal('Q::Newest local', 'Test.md');
    expect((await service.due()).items[0].sideB).toBe('Newest local');
    expect(sync.pendingCount).toBe(0);
  });
  it('retires a stale queued prefix when its final content is already remote, without overwriting it', async () => {
    const service = setup(); const { client } = await serve(service);
    let state: any = {}; let stored: any[] = [];
    const journal = { load: () => structuredClone(stored), save: (jobs: any[]) => { stored = structuredClone(jobs); } };
    const persist = (next: any) => { state = structuredClone(next); };
    const sync = new RemoteNoteSync(client, state, persist, journal);
    await sync.publish('Daily.md', 'Q::Initial');
    await service.note({ operationId: randomUUID(), path: 'Daily.md', content: 'Q::Latest', expectedRevision: 1 });
    await expect(sync.publish('Daily.md', 'Q::Old queued edit')).rejects.toMatchObject({ status: 409 });
    await sync.stageCurrent('Daily.md', 'Q::Latest');
    const recovered = new RemoteNoteSync(client, state, persist, journal);
    await recovered.retry();
    expect(recovered.pendingCount).toBe(0); expect(stored).toEqual([]);
    expect(state['Daily.md'].revision).toBe(2);
    expect((await service.notes()).notes[0].revision).toBe(2);
    await recovered.publish('Daily.md', 'Q::Next normal edit');
    expect((await service.due()).items[0].sideB).toBe('Next normal edit');
  });
  it('publishes independent notes while retaining a genuine conflict and its error', async () => {
    const service = setup(); const { client } = await serve(service);
    const sync = new RemoteNoteSync(client, {}, () => {});
    await sync.publish('Daily.md', 'Q::Initial');
    await service.note({ operationId: randomUUID(), path: 'Daily.md', content: 'Q::Remote change', expectedRevision: 1 });
    await expect(sync.publish('Daily.md', 'Q::Local change')).rejects.toThrow('Daily.md');
    await expect(sync.publish('Science.md', 'Science::Published')).resolves.toBeUndefined();
    expect(sync.pendingCount).toBe(1); expect(sync.conflictPath).toBe('Daily.md');
    expect((await service.due()).items.map(i => i.sideB)).toContain('Published');
    await expect(sync.retry()).rejects.toMatchObject({ status: 409 });
    expect((await service.due()).items.map(i => i.sideB)).toContain('Remote change');
  });
  it('propagates a conflict through a rename chain but not to unrelated paths', async () => {
    const service = setup(); const { client } = await serve(service);
    const sync = new RemoteNoteSync(client, {}, () => {});
    await sync.publish('A.md', 'Q::Initial');
    await service.note({ operationId: randomUUID(), path: 'A.md', content: 'Q::Remote', expectedRevision: 1 });
    await expect(sync.publish('A.md', 'Q::Local')).rejects.toThrow();
    sync.stageRename('A.md', 'B.md'); sync.stageRename('B.md', 'C.md');
    await sync.stageCurrent('C.md', 'Q::Moved');
    await sync.publish('Independent.md', 'Other::OK');
    expect((await service.notes()).notes.map(n => n.path).sort()).toEqual(['A.md', 'Independent.md']);
    expect(sync.pendingCount).toBe(4);
  });
  it('rebases only when the content of the expected base is still identical', async () => {
    const service = setup(); const { client } = await serve(service);
    const sync = new RemoteNoteSync(client, {}, () => {});
    await sync.publish('Test.md', 'Q::Base');
    await service.note({ operationId: randomUUID(), path: 'Test.md', content: 'Q::Temporary', expectedRevision: 1 });
    await service.note({ operationId: randomUUID(), path: 'Test.md', content: 'Q::Base', expectedRevision: 2 });
    await sync.publish('Test.md', 'Q::New local edit');
    expect(sync.pendingCount).toBe(0);
    expect((await service.notes()).notes[0].revision).toBe(4);
    expect((await service.due()).items[0].sideB).toBe('New local edit');
  });
  it('does not compact across a pending deletion even if an older edit matches the server', async () => {
    const service = setup(); const { client } = await serve(service);
    const sync = new RemoteNoteSync(client, {}, () => {});
    await sync.publish('Test.md', 'Q::Initial');
    await service.note({ operationId: randomUUID(), path: 'Test.md', content: 'Q::Remote', expectedRevision: 1 });
    await expect(sync.publish('Test.md', 'Q::Old')).rejects.toThrow();
    await sync.stageCurrent('Test.md', 'Q::Remote'); sync.stageDelete('Test.md');
    await expect(sync.retry()).rejects.toThrow();
    expect(sync.pendingCount).toBe(3);
    expect((await service.notes()).notes[0].deleted).toBe(false);
  });
  it('keeps an explicit deletion durable until acknowledgement', async () => {
    const service = setup(); const { client } = await serve(service);
    let state: any = {}; let stored: any[] = [];
    const journal = { load: () => structuredClone(stored), save: (jobs: any[]) => { stored = structuredClone(jobs); } };
    const persist = (next: any) => { state = structuredClone(next); };
    const sync = new RemoteNoteSync(client, state, persist, journal);
    await sync.publish('Removed.md', 'Q::A');
    sync.stageDelete('Removed.md'); sync.close();
    expect(stored).toHaveLength(1);
    await new RemoteNoteSync(client, state, persist, journal).retry();
    expect((await service.notes()).notes[0].deleted).toBe(true);
    expect(stored).toHaveLength(0);
  });
  it('does not clear a durable review after its client was unloaded mid-request', async () => {
    const service = setup(); await seed(service); const { client: original } = await serve(service);
    let stored: any[] = [];
    const journal = { load: () => structuredClone(stored), save: (jobs: any[]) => { stored = structuredClone(jobs); } };
    let release!: () => void; let started!: () => void;
    const arrived = new Promise<void>(r => { started = r; });
    const gate = new Promise<void>(r => { release = r; });
    const client = new RemoteClient(original.settings, async (...args) => {
      const result = await fetch(...args); started(); await gate; return result;
    }, journal);
    const [item] = await original.getDueStudyItems.execute();
    const sending = expect(client.reviewStudyItem.execute({ studyItemId: item.studyItemId, rating: Rating.Good, expectedRevision: item.revision })).rejects.toThrow('closed');
    await arrived; client.close(); release(); await sending;
    expect(stored).toHaveLength(1);
    await new RemoteClient(original.settings, fetch, journal).retryPendingReviews();
    expect(await service.query(c => c.reviewLog.findAll())).toHaveLength(1);
  });
  it('recovers a review across client reconstruction with the original operation ID', async () => {
    const service = setup(); await seed(service);
    const { client: original } = await serve(service);
    let stored: any[] = [];
    const journal = { load: () => structuredClone(stored), save: (jobs: any[]) => { stored = structuredClone(jobs); } };
    const lost: typeof fetch = async (...args) => { await fetch(...args); throw new Error('Lost receipt'); };
    const client = new RemoteClient(original.settings, lost, journal);
    const [item] = await original.getDueStudyItems.execute();
    await expect(client.reviewStudyItem.execute({ studyItemId: item.studyItemId, rating: Rating.Good, expectedRevision: item.revision })).rejects.toThrow();
    expect(stored).toHaveLength(1);
    await new RemoteClient(original.settings, fetch, journal).retryPendingReviews();
    expect(stored).toHaveLength(0);
    expect(await service.query(c => c.reviewLog.findAll())).toHaveLength(1);
  });
  it('does not send a review when its journal cannot be saved', async () => {
    const service = setup(); await seed(service); const { client: original } = await serve(service);
    const client = new RemoteClient(original.settings, fetch, { load: () => [], save: () => { throw new Error('Disk full'); } });
    const [item] = await original.getDueStudyItems.execute();
    await expect(client.reviewStudyItem.execute({ studyItemId: item.studyItemId, rating: Rating.Good, expectedRevision: item.revision })).rejects.toThrow('Disk full');
    expect(await service.query(c => c.reviewLog.findAll())).toHaveLength(0);
  });
  it('recovers a rename receipt after client restart without renaming twice', async () => {
    const service = setup(); const { client } = await serve(service);
    let state: any = {}; let stored: any[] = [];
    const journal = { load: () => structuredClone(stored), save: (jobs: any[]) => { stored = structuredClone(jobs); } };
    const persist = (next: any) => { state = structuredClone(next); };
    const sync = new RemoteNoteSync(client, state, persist, journal);
    await sync.publish('Old.md', 'Q::A');
    const proxy = client as unknown as { transport: typeof fetch }; const original = proxy.transport;
    proxy.transport = async (...args) => { const result = await original(...args); if (String(args[0]).endsWith('/notes/rename')) throw new Error('Lost rename receipt'); return result; };
    await expect(sync.rename('Old.md', 'New.md')).rejects.toThrow();
    proxy.transport = original;
    await new RemoteNoteSync(client, state, persist, journal).retry();
    expect(stored).toHaveLength(0);
    expect((await service.notes()).notes.filter(note => !note.deleted).map(note => note.path)).toEqual(['New.md']);
  });
  it('recovers the latest note edits after an offline restart', async () => {
    const service = setup(); const { client } = await serve(service);
    let state: any = {}; let stored: any[] = [];
    const journal = { load: () => structuredClone(stored), save: (jobs: any[]) => { stored = structuredClone(jobs); } };
    const persist = (next: any) => { state = structuredClone(next); };
    const sync = new RemoteNoteSync(client, state, persist, journal);
    await sync.publish('Test.md', 'Q::Before');
    const proxy = client as unknown as { transport: typeof fetch }; const original = proxy.transport;
    proxy.transport = async () => { throw new Error('Offline'); };
    await expect(sync.publish('Test.md', 'Q::First edit')).rejects.toThrow();
    await sync.stageCurrent('Test.md', 'Q::Latest edit');
    proxy.transport = original;
    await new RemoteNoteSync(client, state, persist, journal).retry();
    expect(stored).toHaveLength(0);
    expect((await service.due()).items[0].sideB).toBe('Latest edit');
  });
  it('requires an explicit decision to replace a conflicting remote note', async () => {
    const service = setup(); const { client } = await serve(service);
    const sync = new RemoteNoteSync(client, {}, () => {});
    await sync.publish('Test.md', 'Q::Initial');
    await service.note({ operationId: randomUUID(), path: 'Test.md', content: 'Q::Other device', expectedRevision: 1 });
    await expect(sync.publish('Test.md', 'Q::Local edit')).rejects.toMatchObject({ status: 409 });
    expect(sync.pendingCount).toBe(1);
    expect((await service.due()).items[0].sideB).toBe('Other device');
    await sync.resolveWithLocal('Q::Explicit choice');
    expect((await service.due()).items[0].sideB).toBe('Explicit choice');
    expect(sync.pendingCount).toBe(0);
  });
  it('runs the real Obsidian HTTP client without Obsidian or vault storage', async () => {
    const service = setup();
    await seed(service);
    const { client } = await serve(service);
    const [item] = await client.getDueStudyItems.execute();
    expect(item.due).toBeInstanceOf(Date);
    expect(item.preview?.goodDays).toBeDefined();
    expect(client.findSource(item.conceptId)?.filePath).toBe('Test.md');
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
    expect(await service.query(async c => c.indexer.findFileByConceptId(item.conceptId))).toMatchObject({ filePath: 'Folder/New.md' });
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
    expect(client.hasPendingReview()).toBe(true);
    await client.reviewStudyItem.execute({ ...cmd, rating: Rating.Easy });
    const reviews = await service.query(c => c.reviewLog.findAll());
    expect(reviews).toHaveLength(1);
    expect(reviews[0].rating).toBe(Rating.Good);
    expect(client.hasPendingReview()).toBe(false);
  });
  it('reconciles an unresolved receipt after the original view has closed', async () => {
    const service = setup(); await seed(service);
    const { client } = await serve(service);
    const [item] = await client.getDueStudyItems.execute();
    const transport = client as unknown as { transport: typeof fetch };
    const original = transport.transport;
    transport.transport = async (...args) => {
      const result = await original(...args);
      if (args[1]?.method === 'POST') throw new Error('Lost acknowledgement');
      return result;
    };
    await expect(client.reviewStudyItem.execute({ studyItemId: item.studyItemId, expectedRevision: item.revision, rating: Rating.Good })).rejects.toThrow();
    transport.transport = original;
    const listener = () => { throw new Error('Closed UI'); };
    const unsubscribe = client.onChange(listener); unsubscribe();
    await client.retryPendingReviews();
    expect(client.hasPendingReview()).toBe(false);
    expect(await service.query(c => c.reviewLog.findAll())).toHaveLength(1);
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

describe('POST /api/v1/reviews with due queue', () => {
  async function post(service: RecallService, body: unknown) {
    const { url, token } = await serve(service);
    const response = await fetch(`${url}/api/v1/reviews`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  }
  async function note(service: RecallService, path: string, content: string) {
    await service.note({ operationId: randomUUID(), path, content, expectedRevision: 0 });
  }
  const reviewLog = (service: RecallService) => service.query(async c => (await c.reviewLog.findAll()).length);

  it('answers exactly as before when due is absent', async () => {
    const service = setup();
    const res = await post(service, { reviews: [command(await seed(service))] });
    expect(res).toEqual({ status: 200, body: { applied: 1, errors: [] } });
  });
  it('returns the queue after the review, burying the reviewed card and its sibling', async () => {
    const service = setup();
    await note(service, 'Test.md', 'Question:::Answer\nOther::Card');
    const items = await service.query(c => c.studyItemRepository.findAll());
    const item = (await service.due()).items.find(i => i.sideA === 'Question')!;
    const siblings = items.filter(i => i.conceptId.value === item.conceptId).map(i => i.id.value);
    expect(siblings).toHaveLength(2);
    const res = await post(service, { reviews: [command(item)], due: { limit: 50 } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: 1, errors: [] });
    const ids = res.body.due.items.map((i: any) => i.studyItemId);
    for (const id of siblings) expect(ids).not.toContain(id);
    expect(res.body.due.items.map((i: any) => i.conceptId)).not.toContain(item.conceptId);
    expect(res.body.due.items.map((i: any) => i.sideA)).toEqual(['Other']);
    expect(JSON.parse(JSON.stringify(await service.due(undefined, 50)))).toEqual(res.body.due);
  });
  it('still returns the queue when a review is rejected', async () => {
    const service = setup();
    const item = await seed(service);
    const res = await post(service, { reviews: [{ ...command(item), expectedRevision: item.revision + 1 }], due: { limit: 10 } });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(0);
    expect(res.body.errors).toEqual([{ idx: 0, reason: expect.any(String), status: 409 }]);
    expect(res.body.due.items.map((i: any) => i.studyItemId)).toEqual([item.studyItemId]);
  });
  it('rejects an invalid due before applying any review', async () => {
    const service = setup();
    const item = await seed(service);
    for (const due of [null, 5, 'x', [], {}, { limit: 0 }, { limit: 10001 }, { limit: 1.5 }, { limit: '10' }, { limit: 10, deckId: '' }, { limit: 10, deckId: 3 }]) {
      const res = await post(service, { reviews: [command(item)], due });
      expect(res.status, JSON.stringify(due)).toBe(400);
    }
    expect(await reviewLog(service)).toBe(0);
  });
  it('recomputes the queue on a retry with the same operationId', async () => {
    const service = setup();
    await note(service, 'Test.md', 'A::1\nB::2');
    const [first, second] = (await service.due()).items;
    const cmd = command(first);
    const once = await post(service, { reviews: [cmd], due: { limit: 50 } });
    expect(once.body.due.items.map((i: any) => i.studyItemId)).toEqual([second.studyItemId]);
    await service.review(command(second));
    const retry = await post(service, { reviews: [cmd], due: { limit: 50 } });
    expect(retry.body).toEqual({ applied: 1, errors: [], due: { items: [] } });
    expect(await reviewLog(service)).toBe(2);
    expect(service.db.sql.prepare('SELECT result FROM operations').all().every(r => !(r.result as string).includes('items'))).toBe(true);
  });
  it('restricts the queue to the requested deck', async () => {
    const service = setup();
    await note(service, 'German.md', '---\ntags: [German]\n---\nHund::Dog\nKatze::Cat');
    await note(service, 'French.md', '---\ntags: [French]\n---\nChien::Dog');
    const decks = await service.query(c => c.getDeckTree.execute());
    const german = decks.find(d => d.name === 'German')!;
    const item = (await service.due()).items.find(i => i.sideA === 'Hund')!;
    const res = await post(service, { reviews: [command(item)], due: { deckId: german.id, limit: 50 } });
    expect(res.body.due.items.map((i: any) => i.sideA)).toEqual(['Katze']);
    const all = await post(service, { reviews: [command((await service.due()).items.find(i => i.sideA === 'Katze')!)], due: { limit: 50 } });
    expect(all.body.due.items.map((i: any) => i.sideA)).toEqual(['Chien']);
  });
});
