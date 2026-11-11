import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RecallDatabase } from '../../src/server/database';
import { RecallService } from '../../src/server/service';
import { createRecallServer } from '../../src/server/http';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const f of cleanup.splice(0).reverse()) await f(); });

async function serve() {
  const db = new RecallDatabase(':memory:');
  cleanup.push(() => db.close());
  const service = new RecallService(db, { shuffleReviews: false, dailyNewLimit: 0 });
  const token = 'card-edit-secret-'.repeat(3);
  const server = createRecallServer(service, token);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  return { service, call };
}

it('an edited card keeps its study item, scheduling and history, and invalidates queued reviews', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-03-01T10:00:00.000Z'));
  const { service, call } = await serve();
  expect((await call('/notes', { operationId: randomUUID(), path: 'Geo.md', content: '- Capital of France?::Pariss', expectedRevision: 0 })).status).toBe(200);
  const [item] = (await call('/due?limit=10')).body.items;
  const reviewed = await call('/reviews', { reviews: [{ operationId: randomUUID(), studyItemId: item.studyItemId, rating: 'good', expectedRevision: item.revision }] });
  expect(reviewed.body).toEqual({ applied: 1, errors: [] });

  vi.setSystemTime(new Date('2026-06-01T10:00:00.000Z'));
  const [queued] = (await call('/due?limit=10')).body.items;
  expect(queued).toMatchObject({ studyItemId: item.studyItemId, sideB: 'Pariss', reps: 1 });

  expect((await call('/notes', { operationId: randomUUID(), path: 'Geo.md', content: '- Capital of France?::Paris', expectedRevision: 1 })).status).toBe(200);
  const [edited] = (await call('/due?limit=10')).body.items;
  expect(edited).toMatchObject({ studyItemId: item.studyItemId, conceptId: item.conceptId, sideA: 'Capital of France?', sideB: 'Paris', reps: 1 });
  expect(edited.revision).toBeGreaterThan(queued.revision);

  // A review queued with the old text is rejected
  await expect(service.review({ operationId: randomUUID(), studyItemId: item.studyItemId, rating: 'good', expectedRevision: queued.revision }))
    .rejects.toMatchObject({ status: 409 });
  const sources = (await call('/sources')).body;
  expect(sources.fileIndices['Geo.md'].cardKeys).toEqual({ [JSON.stringify(['Capital of France?', 'Paris', 'unidirectional'])]: item.conceptId });
  expect(sources.fileIndices['Geo.md'].studyItemIds).toEqual([item.studyItemId]);
  expect(service.db.sql.prepare('SELECT COUNT(*) AS n FROM reviews').get()!.n).toBe(1);
  expect(service.db.sql.prepare('SELECT COUNT(*) AS n FROM study_items').get()!.n).toBe(1);

  // The current revision is accepted, and the history continues on the same item
  const ok = await call('/reviews', { reviews: [{ operationId: randomUUID(), studyItemId: item.studyItemId, rating: 'good', expectedRevision: edited.revision }] });
  expect(ok.body).toEqual({ applied: 1, errors: [] });
  expect(service.db.sql.prepare('SELECT COUNT(*) AS n FROM reviews WHERE study_item_id=?').get(item.studyItemId)!.n).toBe(2);
});
