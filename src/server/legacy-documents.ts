import type { DatabaseSync } from 'node:sqlite';
import type { SerializedSyncState } from '../context/indexing/domain/source-index';
import { readSourcesSnapshot } from './persistence/sqlite-source-index';
import { DATA_TABLES } from './persistence/schema';

// Shapes of the v2 JSON documents (and of the legacy recall-data files).
export interface SerializedConcept { id: string; sideA: string; sideB: string; directionality: string }
export interface SerializedStudyItem {
  id: string; conceptId: string; direction: string;
  memoryState: { stability: number; difficulty: number; due: string; reps: number; lapses: number; lastReview: string | null };
}
export interface SerializedDeck { id: string; name: string; parentId: string | null; studyItemIds: string[] }
export interface SerializedReview { studyItemId: string; rating: string; timestamp: string }

/** Document keys: concepts, study-items, decks, reviews, sync-state, index-tags, revision:<id>, budget:<ISO day start>. */
export type LegacyDocuments = Record<string, unknown>;

const COLLECTIONS = ['concepts', 'study-items', 'decks', 'reviews', 'sync-state'];

function ms(iso: unknown, what: string): number {
  const value = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(value)) throw new Error(`Invalid ${what} timestamp: ${String(iso)}`);
  return value;
}
const values = <T>(doc: unknown) => Object.values((doc ?? {}) as Record<string, T>);

/** Writes legacy documents into empty v3 tables. Unknown keys abort; nothing is "repaired". */
export function importDocuments(sql: DatabaseSync, docs: LegacyDocuments): void {
  for (const key of Object.keys(docs)) {
    if (!COLLECTIONS.includes(key) && key !== 'index-tags' && !/^(revision|budget):./.test(key)) throw new Error(`Unknown legacy document: ${key}`);
  }
  const concept = sql.prepare('INSERT INTO concepts VALUES (?,?,?,?)');
  for (const c of values<SerializedConcept>(docs.concepts)) concept.run(c.id, c.sideA, c.sideB, c.directionality);
  const item = sql.prepare('INSERT INTO study_items VALUES (?,?,?,?,?,?,?,?,?)');
  for (const i of values<SerializedStudyItem>(docs['study-items'])) {
    const m = i.memoryState;
    item.run(i.id, i.conceptId, i.direction, m.stability, m.difficulty, ms(m.due, 'due'), m.reps, m.lapses,
      m.lastReview === null ? null : ms(m.lastReview, 'lastReview'));
  }
  const deck = sql.prepare('INSERT INTO decks VALUES (?,?,?)');
  // Decks hold a Set: a repeated study item keeps its first position, as Deck.reconstitute does.
  const deckItem = sql.prepare('INSERT INTO deck_items VALUES (?,?) ON CONFLICT DO NOTHING');
  for (const d of values<SerializedDeck>(docs.decks)) {
    deck.run(d.id, d.name, d.parentId);
    for (const id of d.studyItemIds) deckItem.run(d.id, id);
  }
  // Same dedup as the old review log: the first event per (study item, timestamp) wins.
  const review = sql.prepare('INSERT INTO reviews (study_item_id, rating, timestamp) VALUES (?,?,?) ON CONFLICT DO NOTHING');
  for (const r of (docs.reviews ?? []) as SerializedReview[]) review.run(r.studyItemId, r.rating, ms(r.timestamp, 'review'));
  const state = docs['sync-state'] as SerializedSyncState | null | undefined;
  if (state) {
    const file = sql.prepare('INSERT INTO note_files VALUES (?)');
    const card = sql.prepare('INSERT INTO note_cards VALUES (?,?,?)');
    const line = sql.prepare('INSERT INTO note_lines VALUES (?,?,?)');
    const noteItem = sql.prepare('INSERT INTO note_items VALUES (?,?)');
    const noteDeck = sql.prepare('INSERT INTO note_decks VALUES (?,?)');
    for (const [path, index] of Object.entries(state.fileIndices)) {
      file.run(path);
      for (const [key, conceptId] of Object.entries(index.cardKeys)) card.run(path, key, conceptId);
      for (const [conceptId, n] of Object.entries(index.conceptLines ?? {})) line.run(path, conceptId, n);
      for (const id of index.studyItemIds) noteItem.run(path, id);
      for (const id of index.deckIds) noteDeck.run(path, id);
    }
    const tag = sql.prepare('INSERT INTO tag_decks VALUES (?,?)');
    for (const [name, deckId] of Object.entries(state.tagToDeckId)) tag.run(name, deckId);
  }
  if ('index-tags' in docs) sql.prepare("INSERT INTO meta VALUES ('index-tags', ?)").run(JSON.stringify(docs['index-tags']));
  for (const [key, value] of Object.entries(docs)) {
    if (key.startsWith('revision:')) sql.prepare('INSERT INTO item_revisions VALUES (?,?)').run(key.slice(9), value as number);
    if (key.startsWith('budget:')) {
      const budget = value as { introduced: number; reviewed: number };
      sql.prepare('INSERT INTO daily_budgets VALUES (?,?,?)').run(ms(key.slice(7), 'budget'), budget.introduced, budget.reviewed);
    }
  }
}

const iso = (value: unknown) => new Date(value as number).toISOString();

/** Reads the tables back as legacy documents, in the order the application iterates them. */
export function exportDocuments(sql: DatabaseSync): LegacyDocuments {
  const concepts: Record<string, SerializedConcept> = {};
  for (const r of sql.prepare('SELECT * FROM concepts ORDER BY rowid').iterate()) {
    concepts[r.id as string] = { id: r.id as string, sideA: r.side_a as string, sideB: r.side_b as string, directionality: r.directionality as string };
  }
  const items: Record<string, SerializedStudyItem> = {};
  for (const r of sql.prepare('SELECT * FROM study_items ORDER BY rowid').iterate()) {
    items[r.id as string] = {
      id: r.id as string, conceptId: r.concept_id as string, direction: r.direction as string,
      memoryState: {
        stability: r.stability as number, difficulty: r.difficulty as number, due: iso(r.due),
        reps: r.reps as number, lapses: r.lapses as number, lastReview: r.last_review === null ? null : iso(r.last_review),
      },
    };
  }
  const decks: Record<string, SerializedDeck> = {};
  for (const r of sql.prepare('SELECT * FROM decks ORDER BY rowid').iterate()) {
    decks[r.id as string] = { id: r.id as string, name: r.name as string, parentId: r.parent_id as string | null, studyItemIds: [] };
  }
  for (const r of sql.prepare('SELECT deck_id, study_item_id FROM deck_items ORDER BY rowid').iterate()) {
    decks[r.deck_id as string]?.studyItemIds.push(r.study_item_id as string);
  }
  const docs: LegacyDocuments = {
    concepts, 'study-items': items, decks,
    reviews: sql.prepare('SELECT * FROM reviews ORDER BY timestamp, seq').all()
      .map(r => ({ studyItemId: r.study_item_id as string, rating: r.rating as string, timestamp: iso(r.timestamp) })),
    'sync-state': readSourcesSnapshot(sql),
  };
  const tags = sql.prepare("SELECT value FROM meta WHERE key='index-tags'").get();
  if (tags) docs['index-tags'] = JSON.parse(tags.value as string);
  for (const r of sql.prepare('SELECT * FROM item_revisions ORDER BY rowid').iterate()) docs[`revision:${r.study_item_id}`] = r.revision;
  for (const r of sql.prepare('SELECT * FROM daily_budgets ORDER BY day_start').iterate()) {
    docs[`budget:${iso(r.day_start)}`] = { introduced: r.introduced, reviewed: r.reviewed };
  }
  return docs;
}

/** Copy of `value` with `keys` first (when present), then any other key; extra or missing keys still differ. */
function canonical(value: unknown, keys: string[]): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of [...keys.filter(k => k in source), ...Object.keys(source).filter(k => !keys.includes(k))]) out[key] = source[key];
  return out;
}
function mapValues(doc: unknown, f: (v: unknown) => unknown): unknown {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return doc;
  return Object.fromEntries(Object.entries(doc).map(([k, v]) => [k, f(v)]));
}

/**
 * The documents as the v2 application observed them: missing collections read as empty, reviews
 * deduplicated by (study item, timestamp ms) keeping the first and stably sorted by time (the old
 * MultiDeviceReviewLog), deck items deduplicated (Deck holds a Set), a missing `conceptLines` read
 * as empty. Field order inside a record is not significant; order of map keys and arrays is.
 */
export function legacyView(docs: LegacyDocuments): LegacyDocuments {
  const view: LegacyDocuments = {};
  for (const [key, value] of Object.entries(docs)) view[key] = value;
  view.concepts = mapValues(docs.concepts ?? {}, c => canonical(c, ['id', 'sideA', 'sideB', 'directionality']));
  view['study-items'] = mapValues(docs['study-items'] ?? {}, i => {
    const item = canonical(i, ['id', 'conceptId', 'direction', 'memoryState']) as Record<string, unknown>;
    if (item && typeof item === 'object' && 'memoryState' in item) item.memoryState = canonical(item.memoryState, ['stability', 'difficulty', 'due', 'reps', 'lapses', 'lastReview']);
    return item;
  });
  view.decks = mapValues(docs.decks ?? {}, d => {
    const deck = canonical(d, ['id', 'name', 'parentId', 'studyItemIds']) as Record<string, unknown>;
    if (Array.isArray(deck?.studyItemIds)) deck.studyItemIds = [...new Set(deck.studyItemIds)];
    return deck;
  });
  const seen = new Set<string>();
  const time = (r: SerializedReview) => new Date(r.timestamp).getTime();
  view.reviews = ((docs.reviews ?? []) as SerializedReview[])
    .filter(r => { const key = `${r.studyItemId}:${time(r)}`; return !seen.has(key) && !!seen.add(key); })
    .sort((a, b) => time(a) - time(b))
    .map(r => canonical(r, ['studyItemId', 'rating', 'timestamp']));
  const state = canonical(docs['sync-state'] ?? { fileIndices: {}, tagToDeckId: {} }, ['fileIndices', 'tagToDeckId']) as Record<string, unknown>;
  state.fileIndices = mapValues(state.fileIndices, f => canonical({ ...(f as object), conceptLines: (f as SerializedSyncState['fileIndices'][string]).conceptLines ?? {} },
    ['cardKeys', 'conceptLines', 'studyItemIds', 'deckIds']));
  view['sync-state'] = state;
  for (const [key, value] of Object.entries(docs)) {
    if (key.startsWith('budget:')) view[key] = canonical(value, ['introduced', 'reviewed']);
  }
  return view;
}

/** Throws unless `exported` equals the application's view of `original` (key order of maps included). */
export function verifyDocuments(original: LegacyDocuments, exported: LegacyDocuments): void {
  const expected = legacyView(original);
  const keys = (d: LegacyDocuments) => JSON.stringify(Object.keys(d).sort());
  if (keys(expected) !== keys(exported)) throw new Error('Migration verification failed: document keys differ');
  for (const key of Object.keys(expected)) {
    if (JSON.stringify(expected[key]) !== JSON.stringify(exported[key])) throw new Error(`Migration verification failed: ${key} differs`);
  }
}

/** True when no study data and no notes are stored. */
export function isEmpty(sql: DatabaseSync): boolean {
  return [...DATA_TABLES, 'notes'].every(table => !sql.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get());
}
