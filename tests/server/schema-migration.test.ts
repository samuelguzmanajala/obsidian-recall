import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RecallDatabase, payloadHash } from '../../src/server/database';
import { RecallService } from '../../src/server/service';
import { createRecallServer } from '../../src/server/http';
import { exportDocuments } from '../../src/server/legacy-documents';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const f of cleanup.splice(0).reverse()) await f(); });
const golden = JSON.parse(readFileSync(new URL('../context/indexing/application/note-indexer.golden.json', import.meta.url), 'utf8'));
const version = (sql: DatabaseSync) => Number(sql.prepare('PRAGMA user_version').get()!.user_version);
const tables = (sql: DatabaseSync) => sql.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
const settings = { shuffleReviews: false, dailyNewLimit: 0 };
type Row = Record<string, unknown>;

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'recall-v3-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function open(path: string) {
  const db = new RecallDatabase(path);
  cleanup.push(() => db.close());
  return new RecallService(db, settings);
}

const a1 = '---\ntags:\n  - German/vocabulary\n---\n# Vocab\n- Aber:::Pero\n- What is DDD?::Domain-Driven Design\n\nIntro\n- Arbeiten:::Trabajar';
let op = 0;
const note = (s: RecallService, path: string, content: string | null, expectedRevision: number) => s.note({ operationId: `op-${++op}`, path, content, expectedRevision });

/** Builds state natively on v3 with the golden indexer inputs, plus reviews, a tombstone and dangling references. */
async function nativeState(dir: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
  const service = open(join(dir, 'native.sqlite'));
  await service.reindexIfTagsChanged();
  await note(service, 'a.md', a1, 0);
  await note(service, 'b.md', 'Plain::Untagged card', 0);
  await note(service, 'c.md', '---\ntags: [dev]\n---\n- Aber:::Pero', 0);
  await note(service, 'a.md', a1.replace('German/vocabulary', 'German/grammar').replace('\n- Arbeiten:::Trabajar', ''), 1);
  await service.renameNote({ operationId: `op-${++op}`, path: 'b.md', newPath: 'folder/b.md', expectedRevision: 1 });
  const docs = exportDocuments(service.db.sql);
  const store = Object.fromEntries(['decks', 'concepts', 'study-items', 'sync-state'].map(k => [k, docs[k]]));
  expect(JSON.stringify(store)).toBe(JSON.stringify(golden['3-rename'].store));
  await note(service, 'c.md', null, 1); // tombstone
  vi.setSystemTime(new Date('2026-01-03T10:00:00.000Z'));
  const items = (await service.due(undefined, 50)).items;
  for (const [i, rating] of [[0, 'good'], [1, 'again']] as const) {
    vi.setSystemTime(new Date(Date.UTC(2026, 0, 3, 10, i)));
    await service.review({ operationId: `op-${++op}`, studyItemId: items[i].studyItemId, rating, expectedRevision: items[i].revision });
  }
  // Imported data may reference things that no longer exist; they are carried over untouched.
  const untagged = (docs['sync-state'] as { tagToDeckId: Record<string, string> }).tagToDeckId.__untagged__;
  service.db.sql.prepare('INSERT INTO deck_items VALUES (?,?)').run(untagged, 'ghost-item');
  service.db.sql.prepare('INSERT INTO note_items VALUES (?,?)').run('folder/b.md', 'ghost-item');
  service.db.sql.prepare('INSERT INTO note_cards VALUES (?,?,?)').run('folder/b.md', '["Ghost","Card","unidirectional"]', 'ghost-concept');
  const rows = (table: string) => service.db.sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Row[];
  return { service, documents: exportDocuments(service.db.sql), notes: rows('notes'), operations: rows('operations') };
}

function writeV2(path: string, documents: Row, notes: Row[], operations: Row[]) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE documents (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE operations (id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE notes (path TEXT PRIMARY KEY, content TEXT, revision INTEGER NOT NULL);
    PRAGMA user_version=2;`);
  for (const [key, value] of Object.entries(documents)) db.prepare('INSERT INTO documents VALUES (?,?)').run(key, JSON.stringify(value));
  for (const n of notes) db.prepare('INSERT INTO notes VALUES (?,?,?)').run(n.path as string, n.content as string | null, n.revision as number);
  for (const o of operations) db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(o.id as string, o.payload_hash as string, o.result as string, o.created_at as number);
  db.close();
}

/** v2 stored the review log as appended by devices: unsorted, possibly with exact duplicates. */
function asLegacy(documents: Row): Row {
  const legacy = structuredClone(documents);
  const reviews = legacy.reviews as Row[];
  legacy.reviews = [...reviews].reverse().concat([{ ...reviews[0] }]);
  return legacy;
}

async function http(service: RecallService) {
  const token = 'migration-test-token-'.repeat(2);
  const server = createRecallServer(service, token);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  return async (path: string, body?: unknown) => {
    const response = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) });
    return `${response.status} ${await response.text()}`;
  };
}

/** The same requests against two servers must get byte-identical responses. */
async function conversation(service: RecallService) {
  const call = await http(service);
  let seed = 7; // sibling burying picks a direction at random; replay the same choices on both servers
  vi.spyOn(Math, 'random').mockImplementation(() => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const log: string[] = [];
  for (const path of ['/decks', '/due?limit=100', '/sources', '/stats', '/leeches', '/notes', '/note?path=a.md']) log.push(await call(path));
  const items = JSON.parse(log[1].slice(4)).items;
  log.push(await call('/reviews', { reviews: [{ operationId: 'r-1', studyItemId: items[0].studyItemId, rating: 'hard', expectedRevision: items[0].revision }], due: { limit: 100 } }));
  log.push(await call('/notes', { operationId: 'n-1', path: 'a.md', content: '---\ntags: [German/grammar, dev]\n---\n- Aber:::Pero\n- New::Card', expectedRevision: 2 }));
  log.push(await call('/notes', { operationId: 'n-2', path: 'c.md', content: 'Revived::Note', expectedRevision: 2 }));
  for (const path of ['/decks', '/due?limit=100', '/sources', '/stats', '/notes']) log.push(await call(path));
  return log;
}

it('migrates a v2 database to v4, verifies it, and serves exactly what a native v4 server serves', async () => {
  const dir = await tempDir();
  const native = await nativeState(dir);
  const legacy = asLegacy(native.documents);
  expect(Object.keys(legacy)).toEqual(expect.arrayContaining(['index-tags', 'reviews', expect.stringMatching(/^revision:/), expect.stringMatching(/^budget:/)]));
  expect((legacy.reviews as Row[]).length).toBe(3);
  const path = join(dir, 'v2.sqlite');
  writeV2(path, legacy, native.notes, native.operations);

  const migrated = open(path);
  expect(version(migrated.db.sql)).toBe(4);
  expect(tables(migrated.db.sql)).not.toContain('documents');
  const exported = exportDocuments(migrated.db.sql);
  expect(exported).toEqual(native.documents); // the v2 view: reviews deduplicated and sorted
  for (const key of Object.keys(native.documents)) expect(JSON.stringify(exported[key]), key).toBe(JSON.stringify(native.documents[key]));
  expect(JSON.stringify(exported.decks)).toContain('ghost-item');
  expect(JSON.stringify(exported['sync-state'])).toContain('ghost-concept');
  expect(migrated.db.sql.prepare('SELECT * FROM notes ORDER BY rowid').all()).toEqual(native.notes);

  vi.setSystemTime(new Date('2026-01-04T09:00:00.000Z'));
  const expected = await conversation(native.service);
  const actual = await conversation(migrated);
  expect(actual).toEqual(expected);
  expect(actual.filter(r => !r.startsWith('200 '))).toEqual([]);
});

it('chains v1 → v2 → v3 → v4', async () => {
  const dir = await tempDir();
  const native = await nativeState(dir);
  const path = join(dir, 'v1.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE documents (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE operations (id TEXT PRIMARY KEY, payload TEXT NOT NULL, result TEXT NOT NULL);
    CREATE TABLE notes (path TEXT PRIMARY KEY, content TEXT, revision INTEGER NOT NULL);
    PRAGMA user_version=1;`);
  for (const [key, value] of Object.entries(asLegacy(native.documents))) db.prepare('INSERT INTO documents VALUES (?,?)').run(key, JSON.stringify(value));
  db.prepare('INSERT INTO operations VALUES (?,?,?)').run('op', '{"type":"note"}', '{"path":"a.md","revision":1}');
  db.close();
  const service = open(path);
  expect(version(service.db.sql)).toBe(4);
  expect(tables(service.db.sql)).not.toContain('documents');
  expect(exportDocuments(service.db.sql)).toEqual(native.documents);
  expect(service.db.sql.prepare('SELECT payload_hash FROM operations').get()!.payload_hash).toBe(payloadHash('{"type":"note"}'));
});

it.each([
  ['a timestamp that does not round-trip through milliseconds', (d: Row) => {
    const item = Object.values(d['study-items'] as Record<string, { memoryState: { due: string } }>)[0];
    item.memoryState.due = item.memoryState.due.replace('.000Z', 'Z');
  }, /verification failed: study-items differs/],
  ['an unknown document key', (d: Row) => { d['settings'] = { tags: [] }; }, /Unknown legacy document: settings/],
  ['a deck without parentId (it was neither a root nor a child)', (d: Row) => {
    delete Object.values(d.decks as Record<string, Row>)[0].parentId;
  }, /cannot be bound/],
])('aborts on %s and leaves a valid v2 database', async (_, corrupt, error) => {
  const dir = await tempDir();
  const native = await nativeState(dir);
  const documents = asLegacy(native.documents);
  corrupt(documents);
  const path = join(dir, 'v2.sqlite');
  writeV2(path, documents, native.notes, native.operations);
  expect(() => new RecallDatabase(path)).toThrow(error);
  const check = new DatabaseSync(path);
  expect(version(check)).toBe(2);
  expect(tables(check).sort()).toEqual(['documents', 'notes', 'operations']);
  expect(check.prepare('SELECT COUNT(*) AS n FROM documents').get()!.n).toBe(Object.keys(documents).length);
  check.close();
});

it('refuses a database from a newer server', async () => {
  const path = join(await tempDir(), 'v5.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA user_version=5');
  db.close();
  expect(() => new RecallDatabase(path)).toThrow(/newer/);
});

/** A real database written by this server, rewritten to the v3 layout (no card aliases). */
async function v3File(dir: string) {
  const path = join(dir, 'v3.sqlite');
  const db = new RecallDatabase(path);
  const service = new RecallService(db, settings);
  await note(service, 'a.md', a1, 0);
  const [item] = (await service.due()).items;
  await service.review({ operationId: `op-${++op}`, studyItemId: item.studyItemId, rating: 'good', expectedRevision: item.revision });
  await db.close();
  const v3 = new DatabaseSync(path);
  v3.exec('DROP TABLE card_aliases; DROP INDEX note_cards_key; PRAGMA user_version=3;');
  const rows = (table: string) => v3.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  const state = { documents: exportDocuments(v3), notes: rows('notes'), operations: rows('operations') };
  v3.close();
  return { path, state, item };
}

it('migrates v3 → v4 additively: same data, no aliases, and edits then keep their history', async () => {
  const { path, state, item } = await v3File(await tempDir());
  const service = open(path);
  expect(version(service.db.sql)).toBe(4);
  expect(tables(service.db.sql)).toContain('card_aliases');
  expect(service.db.sql.prepare('SELECT COUNT(*) AS n FROM card_aliases').get()!.n).toBe(0);
  expect(exportDocuments(service.db.sql)).toEqual(state.documents);
  expect(service.db.sql.prepare('SELECT * FROM notes ORDER BY rowid').all()).toEqual(state.notes);
  expect(service.db.sql.prepare('SELECT * FROM operations ORDER BY rowid').all()).toEqual(state.operations);
  await note(service, 'a.md', a1.replace('Aber:::Pero', 'Aber:::Pero, aber').replace('Domain-Driven Design', 'Domain-driven design'), 1);
  const items = await service.query(c => c.studyItemRepository.findAll());
  expect(items.find(i => i.id.value === item.studyItemId)!.memoryState.reps).toBe(1);
  expect(service.db.sql.prepare('SELECT COUNT(*) AS n FROM card_aliases').get()!.n).toBe(2);
});

it('leaves a valid v3 database when the v4 migration fails', async () => {
  const { path, state } = await v3File(await tempDir());
  const broken = new DatabaseSync(path);
  broken.exec('CREATE INDEX card_aliases_a_to_b ON notes(path)'); // name clash inside the v4 DDL
  broken.close();
  expect(() => new RecallDatabase(path)).toThrow(/already exists/);
  const check = new DatabaseSync(path);
  expect(version(check)).toBe(3);
  expect(tables(check)).not.toContain('card_aliases');
  expect(exportDocuments(check)).toEqual(state.documents);
  check.close();
});
