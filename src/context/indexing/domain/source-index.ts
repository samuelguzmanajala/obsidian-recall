/** What one note contributed: its cards, their lines, study items and leaf decks. */
export interface FileIndex {
  /** card key (JSON of sideA, sideB, directionality) → conceptId */
  cardKeys: Map<string, string>;
  /** conceptId → line number in the note */
  conceptLines: Map<string, number>;
  /** studyItemIds created for this note (in creation order, may repeat) */
  studyItemIds: string[];
  /** leaf deckIds assigned to this note's cards */
  deckIds: string[];
}

export interface SourceLocation { filePath: string; line: number }

/** Wire shape of `GET /sources` (and of the legacy `sync-state` document). */
export interface SerializedFileIndex {
  cardKeys: Record<string, string>;
  conceptLines?: Record<string, number>;
  studyItemIds: string[];
  deckIds: string[];
}

export interface SerializedSyncState {
  fileIndices: Record<string, SerializedFileIndex>;
  tagToDeckId: Record<string, string>;
}

/**
 * Persistent note index. Files are ordered like a JS Map: `put` on a new path appends it,
 * `put` on an existing path keeps its position, `rename` moves the index to the new path
 * (appended unless that path already exists), `remove` forgets it.
 */
export interface SourceIndex {
  get(path: string): Promise<FileIndex | null>;
  put(path: string, index: FileIndex): Promise<void>;
  remove(path: string): Promise<void>;
  /** No-op when `oldPath` is not indexed. */
  rename(oldPath: string, newPath: string): Promise<void>;
  /** Files other than `excludingPath` that contain the concept, in index order, with their leaf decks. */
  otherFilesWithConcept(conceptId: string, excludingPath: string): Promise<{ path: string; deckIds: string[] }[]>;
  /** First file (in index order) containing the concept; line defaults to 1. */
  locate(conceptId: string): Promise<SourceLocation | null>;
  deckForTag(tag: string): Promise<string | null>;
  /** Appends a new tag mapping (tags are never remapped). */
  setDeckForTag(tag: string, deckId: string): Promise<void>;
  snapshot(): Promise<SerializedSyncState>;
}
