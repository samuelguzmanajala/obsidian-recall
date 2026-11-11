import type { DatabaseSync } from 'node:sqlite';
import type { FileIndex, SerializedSyncState, SourceIndex, SourceLocation } from '../../context/indexing/domain/source-index';
import type { RecallDatabase } from '../database';

/** All files in index order; also used by the legacy export. */
export function readSourcesSnapshot(sql: Pick<DatabaseSync, 'prepare'>): SerializedSyncState {
  const fileIndices: SerializedSyncState['fileIndices'] = {};
  for (const r of sql.prepare('SELECT path FROM note_files ORDER BY rowid').iterate()) {
    fileIndices[r.path as string] = { cardKeys: {}, conceptLines: {}, studyItemIds: [], deckIds: [] };
  }
  for (const r of sql.prepare('SELECT path, card_key, concept_id FROM note_cards ORDER BY rowid').iterate()) {
    const file = fileIndices[r.path as string];
    if (file) file.cardKeys[r.card_key as string] = r.concept_id as string;
  }
  for (const r of sql.prepare('SELECT path, concept_id, line FROM note_lines ORDER BY rowid').iterate()) {
    const file = fileIndices[r.path as string];
    if (file) file.conceptLines![r.concept_id as string] = r.line as number;
  }
  for (const r of sql.prepare('SELECT path, study_item_id FROM note_items ORDER BY rowid').iterate()) fileIndices[r.path as string]?.studyItemIds.push(r.study_item_id as string);
  for (const r of sql.prepare('SELECT path, deck_id FROM note_decks ORDER BY rowid').iterate()) fileIndices[r.path as string]?.deckIds.push(r.deck_id as string);
  const tagToDeckId: Record<string, string> = {};
  for (const r of sql.prepare('SELECT tag, deck_id FROM tag_decks ORDER BY rowid').iterate()) tagToDeckId[r.tag as string] = r.deck_id as string;
  return { fileIndices, tagToDeckId };
}

const CHILDREN = ['note_cards', 'note_lines', 'note_items', 'note_decks'];

export class SqliteSourceIndex implements SourceIndex {
  constructor(private readonly db: RecallDatabase) {}

  async get(path: string): Promise<FileIndex | null> {
    if (!this.db.stmt('SELECT 1 FROM note_files WHERE path=?').get(path)) return null;
    const rows = (table: string, columns: string) => this.db.stmt(`SELECT ${columns} FROM ${table} WHERE path=? ORDER BY rowid`).all(path);
    return {
      cardKeys: new Map(rows('note_cards', 'card_key, concept_id').map(r => [r.card_key as string, r.concept_id as string])),
      conceptLines: new Map(rows('note_lines', 'concept_id, line').map(r => [r.concept_id as string, r.line as number])),
      studyItemIds: rows('note_items', 'study_item_id').map(r => r.study_item_id as string),
      deckIds: rows('note_decks', 'deck_id').map(r => r.deck_id as string),
    };
  }

  async put(path: string, index: FileIndex): Promise<void> {
    this.db.stmt('INSERT INTO note_files VALUES (?) ON CONFLICT DO NOTHING').run(path);
    this.clear(path);
    for (const [key, conceptId] of index.cardKeys) this.db.stmt('INSERT INTO note_cards VALUES (?,?,?)').run(path, key, conceptId);
    for (const [conceptId, line] of index.conceptLines) this.db.stmt('INSERT INTO note_lines VALUES (?,?,?)').run(path, conceptId, line);
    for (const id of index.studyItemIds) this.db.stmt('INSERT INTO note_items VALUES (?,?)').run(path, id);
    for (const id of index.deckIds) this.db.stmt('INSERT INTO note_decks VALUES (?,?)').run(path, id);
  }

  async remove(path: string): Promise<void> {
    this.clear(path);
    this.db.stmt('DELETE FROM note_files WHERE path=?').run(path);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    if (!this.db.stmt('SELECT 1 FROM note_files WHERE path=?').get(oldPath)) return;
    this.clear(newPath);
    for (const table of CHILDREN) this.db.stmt(`UPDATE ${table} SET path=? WHERE path=?`).run(newPath, oldPath);
    this.db.stmt('DELETE FROM note_files WHERE path=?').run(oldPath);
    this.db.stmt('INSERT INTO note_files VALUES (?) ON CONFLICT DO NOTHING').run(newPath);
  }

  async otherFilesWithConcept(conceptId: string, excludingPath: string): Promise<{ path: string; deckIds: string[] }[]> {
    return this.db.stmt(`SELECT path FROM note_files WHERE path IN (SELECT path FROM note_cards WHERE concept_id=?) AND path<>? ORDER BY rowid`)
      .all(conceptId, excludingPath).map(r => ({
        path: r.path as string,
        deckIds: this.db.stmt('SELECT deck_id FROM note_decks WHERE path=? ORDER BY rowid').all(r.path as string).map(d => d.deck_id as string),
      }));
  }

  async locate(conceptId: string): Promise<SourceLocation | null> {
    const row = this.db.stmt(`SELECT f.path, l.line FROM note_files f
      LEFT JOIN note_lines l ON l.path=f.path AND l.concept_id=?
      WHERE f.path IN (SELECT path FROM note_cards WHERE concept_id=?) ORDER BY f.rowid LIMIT 1`).get(conceptId, conceptId);
    return row ? { filePath: row.path as string, line: (row.line as number | null) ?? 1 } : null;
  }

  async deckForTag(tag: string): Promise<string | null> {
    return (this.db.stmt('SELECT deck_id FROM tag_decks WHERE tag=?').get(tag)?.deck_id as string | undefined) ?? null;
  }

  async setDeckForTag(tag: string, deckId: string): Promise<void> {
    this.db.stmt('INSERT INTO tag_decks VALUES (?,?) ON CONFLICT(tag) DO UPDATE SET deck_id=excluded.deck_id').run(tag, deckId);
  }

  async snapshot(): Promise<SerializedSyncState> {
    return readSourcesSnapshot({ prepare: (source: string) => this.db.stmt(source) });
  }

  private clear(path: string) {
    for (const table of CHILDREN) this.db.stmt(`DELETE FROM ${table} WHERE path=?`).run(path);
  }
}
