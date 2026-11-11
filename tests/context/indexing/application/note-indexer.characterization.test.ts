import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createIndexer, type DocumentStore } from './indexer-fixture';

// note-indexer.golden.json was captured from VaultSync (src/app/backend/vault-sync.ts) at
// e76b1c9, before it moved to the kernel. Existing databases store this sync state and
// these content-derived IDs, so the output must stay byte-for-byte identical.
afterEach(() => vi.useRealTimers());

it('produces the same documents, sync state and IDs as the original VaultSync', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
  const out: Record<string, unknown> = {};
  const store: DocumentStore = {};
  const start = async (target: DocumentStore, tags: string[] = []) => {
    const { indexer } = createIndexer(target, tags);
    await indexer.initialize();
    return indexer;
  };
  let ids: string[] = [];
  const snap = (name: string, indexer: Awaited<ReturnType<typeof start>>) => {
    out[name] = {
      store: JSON.parse(JSON.stringify(store)),
      sources: Object.fromEntries(ids.map(id => [id, indexer.findFileByConceptId(id)])),
    };
  };
  const a1 = '---\ntags:\n  - German/vocabulary\n---\n# Vocab\n- Aber:::Pero\n- What is DDD?::Domain-Driven Design\n\nIntro\n- Arbeiten:::Trabajar';

  let indexer = await start(store);
  await indexer.syncFile('a.md', a1);
  await indexer.syncFile('b.md', 'Plain::Untagged card');
  await indexer.syncFile('c.md', '---\ntags: [dev]\n---\n- Aber:::Pero');
  ids = [...new Set(Object.values((store['sync-state'] as any).fileIndices).flatMap((f: any) => Object.values(f.cardKeys) as string[]))];
  snap('1-initial', indexer);

  indexer = await start(store); // restart from the persisted sync state
  await indexer.syncFile('a.md', a1.replace('German/vocabulary', 'German/grammar').replace('\n- Arbeiten:::Trabajar', ''));
  snap('2-retag-and-remove-card', indexer);
  await indexer.renameFile('b.md', 'folder/b.md');
  await indexer.syncFile('folder/b.md', 'Plain::Untagged card');
  snap('3-rename', indexer);
  await indexer.removeFile('c.md');
  await indexer.syncFile('a.md', '# no cards anymore');
  snap('4-remove', indexer);

  const filtered: DocumentStore = {};
  const f = await start(filtered, ['German']);
  await f.syncFile('x.md', '---\ntags: [German/x, dev]\n---\n- Hallo:::Hola');
  await f.syncFile('y.md', '---\ntags: [dev]\n---\n- Only::dev');
  await f.syncFile('z.md', '- No::tags');
  out['5-filtered'] = { store: JSON.parse(JSON.stringify(filtered)) };

  const golden = readFileSync(new URL('./note-indexer.golden.json', import.meta.url), 'utf8');
  expect(JSON.stringify(out, null, 2) + '\n').toBe(golden);
});
