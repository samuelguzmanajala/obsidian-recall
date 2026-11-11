import { afterEach, expect, it } from 'vitest';
import type { StatementSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { RecallDatabase } from '../../src/server/database';
import { RecallService } from '../../src/server/service';
import { importDocuments } from '../../src/server/legacy-documents';

// v2 parsed and rewrote the whole review history on every review. Count what one review reads and
// writes with a small and a large history: it must be the same.
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0)) await f(); });

function seeded(items: number, reviewsPerItem: number) {
  const db = new RecallDatabase(':memory:');
  cleanup.push(() => db.close());
  const day = 86_400_000, start = Date.now() - 400 * day;
  const docs = { concepts: {} as Record<string, unknown>, 'study-items': {} as Record<string, unknown>, reviews: [] as unknown[],
    decks: { d: { id: 'd', name: 'Deck', parentId: null, studyItemIds: [] as string[] } } };
  for (let i = 0; i < items; i++) {
    docs.concepts[`c${i}`] = { id: `c${i}`, sideA: `Q${i}`, sideB: `A${i}`, directionality: 'unidirectional' };
    const last = start + (reviewsPerItem - 1) * day;
    docs['study-items'][`s${i}`] = { id: `s${i}`, conceptId: `c${i}`, direction: 'a-to-b', memoryState: {
      stability: 3, difficulty: 5, due: new Date(last + day).toISOString(), reps: reviewsPerItem, lapses: 0, lastReview: new Date(last).toISOString() } };
    docs.decks.d.studyItemIds.push(`s${i}`);
    for (let r = 0; r < reviewsPerItem; r++) docs.reviews.push({ studyItemId: `s${i}`, rating: 'good', timestamp: new Date(start + r * day + i).toISOString() });
  }
  db.sql.exec('BEGIN'); importDocuments(db.sql, docs); db.sql.exec('COMMIT');
  // Count every row a storage adapter hands back to JavaScript, and every byte it binds to a write.
  const counter = { rows: 0, statements: 0, bytes: 0 };
  const stmt = db.stmt.bind(db);
  db.stmt = (source: string) => {
    const s = stmt(source);
    counter.statements++;
    return {
      get: (...args: never[]) => { const row = s.get(...args); if (row) counter.rows++; return row; },
      all: (...args: never[]) => { const rows = s.all(...args); counter.rows += rows.length; return rows; },
      run: (...args: never[]) => { counter.bytes += args.reduce((n, a) => n + String(a).length, 0); return s.run(...args); },
    } as unknown as StatementSync;
  };
  return { service: new RecallService(db, { shuffleReviews: false, dailyNewLimit: 0 }), counter, db };
}

async function measureReview(items: number, reviewsPerItem: number) {
  const { service, counter, db } = seeded(items, reviewsPerItem);
  const changes = () => Number(db.sql.prepare('SELECT total_changes() AS n').get()!.n);
  const reviews = () => Number(db.sql.prepare('SELECT COUNT(*) AS n FROM reviews').get()!.n);
  const item = (await service.due(undefined, 1)).items[0];
  const before = { ...counter, changes: changes(), reviews: reviews() };
  await service.review({ operationId: randomUUID(), studyItemId: item.studyItemId, rating: 'good', expectedRevision: item.revision });
  expect(reviews()).toBe(before.reviews + 1);
  return { rowsRead: counter.rows - before.rows, statements: counter.statements - before.statements,
    bytesWritten: counter.bytes - before.bytes, rowsWritten: changes() - before.changes };
}

it('a review reads and writes the same handful of rows whatever the size of the history', async () => {
  const small = await measureReview(10, 3);
  const large = await measureReview(3000, 6); // 18,000 reviews
  expect(large).toEqual(small);
  // study item, review, daily budget, item revision and receipt
  expect(large.rowsWritten).toBe(5);
  expect(large.rowsRead).toBeLessThan(10);
  expect(large.bytesWritten).toBeLessThan(200);
});
