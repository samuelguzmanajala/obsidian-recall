import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { RecallDatabase } from '../../src/server/database';
import { RecallService } from '../../src/server/service';
import { exportDocuments } from '../../src/server/legacy-documents';
import { Rating } from '../../src/context/study/domain/rating';
import { HttpLlmClient } from '../../src/context/shared/infrastructure/llm-adapters';
import { OpenAiTtsClient } from '../../src/context/shared/infrastructure/openai-tts-client';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'recall-ops-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function open(path = ':memory:') {
  const db = new RecallDatabase(path);
  cleanup.push(() => db.close());
  return new RecallService(db, { shuffleReviews: false, dailyNewLimit: 0 });
}
const version = (sql: DatabaseSync) => Number(sql.prepare('PRAGMA user_version').get()!.user_version);
const reviewCount = (s: RecallService) => s.db.sql.prepare('SELECT COUNT(*) AS n FROM reviews').get()!.n;
const V1_DDL = `
  CREATE TABLE documents (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE operations (id TEXT PRIMARY KEY, payload TEXT NOT NULL, result TEXT NOT NULL);
  CREATE TABLE notes (path TEXT PRIMARY KEY, content TEXT, revision INTEGER NOT NULL);
  PRAGMA user_version=1;`;

describe('operation receipts', () => {
  it('creates v4 directly and never stores note content in receipts', async () => {
    const service = open();
    expect(version(service.db.sql)).toBe(4);
    expect(service.db.sql.prepare('PRAGMA table_info(operations)').all().map(c => c.name)).toEqual(['id', 'payload_hash', 'result', 'created_at']);
    const content = 'Secret question::Secret answer';
    await service.note({ operationId: randomUUID(), path: 'Test.md', content, expectedRevision: 0 });
    const rows = service.db.sql.prepare('SELECT * FROM operations').all();
    expect(rows).toHaveLength(1);
    expect(rows.every(r => !Object.values(r).some(v => typeof v === 'string' && v.includes('Secret')))).toBe(true);
  });

  it('migrates v1 receipts so pre-migration retries are still recognised', async () => {
    const dir = await tempDir();
    // Produce real state with the current server, then rebuild it as a v1 file with v1-shaped receipts.
    const source = new RecallDatabase(join(dir, 'source.sqlite'));
    const s0 = new RecallService(source, { shuffleReviews: false, dailyNewLimit: 0 });
    const note = { operationId: randomUUID(), path: 'Test.md', content: 'Question::Answer', expectedRevision: 0 };
    const noteResult = await s0.note(note);
    const item = (await s0.due()).items[0];
    const review = { operationId: randomUUID(), studyItemId: item.studyItemId, rating: Rating.Good, expectedRevision: item.revision };
    const reviewResult = await s0.review(review);
    const documents = Object.entries(exportDocuments(source.sql)).map(([key, value]) => ({ key, value: JSON.stringify(value) }));
    const notes = source.sql.prepare('SELECT path,content,revision FROM notes').all();
    await source.close();

    const path = join(dir, 'v1.sqlite');
    const v1 = new DatabaseSync(path);
    v1.exec(V1_DDL);
    for (const d of documents) v1.prepare('INSERT INTO documents VALUES (?,?)').run(d.key as string, d.value as string);
    for (const n of notes) v1.prepare('INSERT INTO notes VALUES (?,?,?)').run(n.path as string, n.content as string, n.revision as number);
    const ops = [
      [note.operationId, { type: 'note', path: note.path, content: note.content, expectedRevision: 0 }, noteResult],
      [review.operationId, { type: 'review', studyItemId: review.studyItemId, rating: review.rating, expectedRevision: review.expectedRevision }, reviewResult],
    ] as const;
    for (const [id, payload, result] of ops) v1.prepare('INSERT INTO operations VALUES (?,?,?)').run(id, JSON.stringify(payload), JSON.stringify(result));
    v1.close();

    const service = open(path);
    expect(version(service.db.sql)).toBe(4);
    expect(service.db.sql.prepare('PRAGMA table_info(operations)').all().map(c => c.name)).toEqual(['id', 'payload_hash', 'result', 'created_at']);
    expect(service.db.sql.prepare('SELECT COUNT(*) AS n FROM operations').get()!.n).toBe(2);
    expect(await service.review(review)).toEqual(reviewResult);
    expect(await service.note(note)).toEqual(noteResult);
    expect(reviewCount(service)).toBe(1);
    await expect(service.review({ ...review, rating: Rating.Hard })).rejects.toMatchObject({ status: 409, message: 'operationId was already used for a different command' });
    expect(service.db.sql.prepare('SELECT path,content,revision FROM notes').all()).toEqual(notes);
    expect(Object.keys(exportDocuments(service.db.sql))).toEqual(expect.arrayContaining(documents.map(d => d.key)));
  });

  it('leaves a valid v1 database when the migration fails', async () => {
    const path = join(await tempDir(), 'v1.sqlite');
    const v1 = new DatabaseSync(path);
    v1.exec(V1_DDL + 'CREATE TABLE operations_v2 (x);');
    v1.prepare('INSERT INTO operations VALUES (?,?,?)').run('op', '{}', '{}');
    v1.close();
    expect(() => new RecallDatabase(path)).toThrow();
    const check = new DatabaseSync(path);
    expect(version(check)).toBe(1);
    expect(check.prepare('SELECT payload FROM operations').get()!.payload).toBe('{}');
    check.close();
  });

  it('refuses a database from a newer server', async () => {
    const path = join(await tempDir(), 'v5.sqlite');
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version=5');
    db.close();
    expect(() => new RecallDatabase(path)).toThrow(/newer/);
  });

  it('expires old receipts; an expired review retry is rejected, not reapplied', async () => {
    const service = open();
    await service.note({ operationId: randomUUID(), path: 'Test.md', content: 'Question::Answer', expectedRevision: 0 });
    const item = (await service.due()).items[0];
    const review = { operationId: randomUUID(), studyItemId: item.studyItemId, rating: Rating.Good, expectedRevision: item.revision };
    await service.review(review);
    const count = () => service.db.sql.prepare('SELECT COUNT(*) AS n FROM operations').get()!.n;
    const later = Date.now() + 91 * 86_400_000;
    expect(await service.expireReceipts(90)).toBe(0);
    expect(await service.expireReceipts(0, later)).toBe(0);
    expect(await service.expireReceipts(100, later)).toBe(0);
    expect(count()).toBe(2);
    expect(await service.expireReceipts(90, later)).toBe(2);
    expect(count()).toBe(0);
    await expect(service.review(review)).rejects.toMatchObject({ status: 409 });
    expect(reviewCount(service)).toBe(1);
  });
});

describe('provider timeouts', () => {
  const hanging = ((_url: string, init: RequestInit) => new Promise((_, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
  })) as unknown as typeof fetch;

  it('aborts a hung LLM request', async () => {
    const client = new HttpLlmClient(() => 'openai', () => 'key', () => '', 20, hanging);
    await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow('LLM request timed out after 0.02 s');
  });

  it('aborts a hung TTS request', async () => {
    const client = new OpenAiTtsClient(() => 'key', hanging, 20);
    await expect(client.synthesize({ text: 'hi', voice: 'alloy', format: 'mp3' })).rejects.toThrow('OpenAI TTS request timed out after 0.02 s');
  });
});
