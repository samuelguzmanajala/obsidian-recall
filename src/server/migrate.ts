import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { RecallDatabase } from './database';
import { RecallService } from './service';
import { Rating } from '../context/study/domain/rating';
import { Direction } from '../context/study/domain/direction';
import type { SerializedReview, SerializedSyncState } from '../context/shared/infrastructure/json-storage';

/** Read-only source; never merge two independent scheduling authorities. Target must be empty. */
export async function importLegacy(source: string, db: RecallDatabase) {
  const documents: Record<string, unknown> = {};
  for (const name of ['concepts', 'study-items', 'decks', 'sync-state']) {
    documents[name] = JSON.parse(await readFile(join(source, `${name}.json`), 'utf8'));
    if (!documents[name] || typeof documents[name] !== 'object' || Array.isArray(documents[name])) throw new Error(`Invalid ${name}`);
  }
  const reviewFiles = (await readdir(source)).filter(f => /^reviews(?:-[^.]+)?\.json$/.test(f)).sort();
  const merged = new Map<string, SerializedReview>();
  for (const file of reviewFiles) {
    const reviews: SerializedReview[] = JSON.parse(await readFile(join(source, file), 'utf8'));
    if (!Array.isArray(reviews)) throw new Error(`Invalid ${file}`);
    for (const r of reviews) {
      if (!r || typeof r.studyItemId !== 'string' || !Object.values(Rating).includes(r.rating as Rating) || !Number.isFinite(Date.parse(r.timestamp))) throw new Error(`Invalid review in ${file}`);
      const key = `${r.studyItemId}:${Date.parse(r.timestamp)}`;
      const previous = merged.get(key);
      if (previous && previous.rating !== r.rating) throw new Error('Conflicting legacy review history; resolve before importing');
      merged.set(key, r);
    }
  }
  documents.reviews = [...merged.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return db.transaction(async () => {
    if (db.sql.prepare('SELECT key FROM documents LIMIT 1').get() || db.sql.prepare('SELECT path FROM notes LIMIT 1').get()) throw new Error('Target database is not empty; refusing to overwrite');
    for (const [key, data] of Object.entries(documents)) await db.document(key).write(data);
    const c = await new RecallService(db).context();
    const concepts = await c.conceptRepository.findAll();
    const items = await c.studyItemRepository.findAll();
    const decks = await c.deckRepository.findAll();
    const ids = new Set(concepts.map(c => c.id.value));
    const itemIds = new Set(items.map(i => i.id.value));
    for (const item of items) {
      const m = item.memoryState;
      if (!ids.has(item.conceptId.value) || !Object.values(Direction).includes(item.direction)
        || !Number.isFinite(m.due.getTime()) || (m.lastReview !== null && !Number.isFinite(m.lastReview.getTime()))
        || ![m.stability, m.difficulty, m.reps, m.lapses].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)
        || !Number.isInteger(m.reps) || !Number.isInteger(m.lapses) || m.difficulty > 10) throw new Error('Invalid legacy study item');
    }
    const deckById = new Map(decks.map(d => [d.id.value, d]));
    for (const deck of decks) {
      if (typeof deck.name !== 'string' || !deck.name.trim()) throw new Error('Invalid deck name');
      if (deck.studyItemIds.some(id => !itemIds.has(id.value))) throw new Error('Dangling study item in legacy deck');
      const visited = new Set([deck.id.value]);
      let parent = deck.parentId;
      while (parent) {
        if (visited.has(parent.value)) throw new Error('Cycle in legacy deck hierarchy');
        visited.add(parent.value);
        const ancestor = deckById.get(parent.value);
        if (!ancestor) throw new Error('Missing parent deck');
        parent = ancestor.parentId;
      }
    }
    const state = documents['sync-state'] as SerializedSyncState;
    for (const index of Object.values(state.fileIndices)) {
      if (Object.values(index.cardKeys).some(id => !ids.has(id)) || index.studyItemIds.some(id => !itemIds.has(id))
        || index.deckIds.some(id => !deckById.has(id))) throw new Error('Legacy sync index is inconsistent');
    }
    // Keep MemoryState exactly as exported; replay is not implicit (SR imports may not have review events).
    return { concepts: concepts.length, studyItems: items.length, decks: decks.length, reviews: merged.size };
  });
}

if (require.main === module) {
  process.umask(0o077);
  const [source, target, flag] = process.argv.slice(2);
  if (!source || !target || (flag && flag !== '--apply')) throw new Error('Usage: migrate.cjs <recall-data-folder> <target.sqlite> [--apply] (default: dry run)');
  const db = new RecallDatabase(flag === '--apply' ? resolve(target) : ':memory:');
  importLegacy(resolve(source), db).then(result => console.log(flag === '--apply' ? 'Imported:' : 'Validated (dry run):', result))
    .catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.close());
}
