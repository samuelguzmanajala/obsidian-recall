import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RecallDatabase } from '../../src/server/database';
import { RecallService } from '../../src/server/service';
import { importLegacy } from '../../src/server/migrate';
import { exportDocuments } from '../../src/server/legacy-documents';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'recall-migration-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const source = new RecallDatabase(':memory:');
  cleanup.push(() => source.close());
  const service = new RecallService(source);
  await service.note({ operationId: randomUUID(), path: 'Test.md', content: 'Question::Answer', expectedRevision: 0 });
  const [item] = (await service.due()).items;
  await service.review({ operationId: randomUUID(), studyItemId: item.studyItemId, rating: 'good', expectedRevision: item.revision });
  const exported = exportDocuments(source.sql);
  const documents = Object.fromEntries(['concepts', 'study-items', 'decks', 'sync-state', 'reviews'].map(name => [name, exported[name]]));
  for (const [name, value] of Object.entries(documents)) await writeFile(join(dir, `${name}.json`), JSON.stringify(value));
  // Multiple device files may contain the exact same review; import deduplicates.
  await writeFile(join(dir, 'reviews-second-device.json'), JSON.stringify(documents.reviews));
  const target = new RecallDatabase(':memory:'); cleanup.push(() => target.close());
  return { dir, documents, target };
}

it('imports scheduling/history exactly and leaves source files untouched', async () => {
  const { dir, documents, target } = await fixture();
  expect(await importLegacy(dir, target)).toMatchObject({ studyItems: 1, reviews: 1 });
  expect(exportDocuments(target.sql)['study-items']).toEqual(documents['study-items']);
  expect(JSON.parse(await readFile(join(dir, 'study-items.json'), 'utf8'))).toEqual(documents['study-items']);
  await expect(importLegacy(dir, target)).rejects.toThrow('not empty');
});

it('rolls back the entire import if references are inconsistent', async () => {
  const { dir, target } = await fixture();
  await writeFile(join(dir, 'concepts.json'), '{}');
  await expect(importLegacy(dir, target)).rejects.toThrow();
  expect(exportDocuments(target.sql)['study-items']).toEqual({});
});

it('refuses ambiguous review history rather than silently picking a device', async () => {
  const { dir, documents, target } = await fixture();
  const reviews = structuredClone(documents.reviews) as { rating: string }[];
  reviews[0].rating = 'again';
  await writeFile(join(dir, 'reviews-second-device.json'), JSON.stringify(reviews));
  await expect(importLegacy(dir, target)).rejects.toThrow('Conflicting legacy');
});
