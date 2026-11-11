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

/**
 * IDs a card key inherited from an edited card (they are not the hash of the key's content).
 * Durable: kept after the card is removed, so re-adding the same content restores its history.
 */
export interface CardAlias { conceptId: string; aToB: string; bToA: string | null }

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
  /** Concept of the first file (in index order) that lists this card key. */
  conceptForCard(cardKey: string): Promise<string | null>;
  aliasFor(cardKey: string): Promise<CardAlias | null>;
  /** Card key of the alias that holds `id` as its concept or one of its study items. */
  aliasOwner(id: string): Promise<string | null>;
  /** Replaces the alias of `cardKey` and any other alias of the same concept (one key per concept). */
  setAlias(cardKey: string, alias: CardAlias): Promise<void>;
}
