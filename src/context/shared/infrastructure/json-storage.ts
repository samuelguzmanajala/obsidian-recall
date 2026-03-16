/**
 * Generic JSON file storage port.
 * Each repository gets its own instance pointing to a different file.
 */
export interface JsonFilePort {
  read<T>(): Promise<T | null>;
  write<T>(data: T): Promise<void>;
}

// Serialization types

export interface SerializedConcept {
  id: string;
  sideA: string;
  sideB: string;
  directionality: string;
}

export interface SerializedStudyItem {
  id: string;
  conceptId: string;
  direction: string;
  memoryState: {
    stability: number;
    difficulty: number;
    due: string;
    reps: number;
    lapses: number;
    lastReview: string | null;
  };
}

export interface SerializedDeck {
  id: string;
  name: string;
  parentId: string | null;
  studyItemIds: string[];
}

export interface SerializedReview {
  studyItemId: string;
  rating: string;
  timestamp: string;
}

export interface SerializedFileIndex {
  /** Map of "sideA|sideB|directionality" → conceptId */
  cardKeys: Record<string, string>;
  /** studyItemIds created for this file */
  studyItemIds: string[];
  /** deckIds (leaf decks) assigned to this file's cards */
  deckIds: string[];
}

export interface SerializedSyncState {
  fileIndices: Record<string, SerializedFileIndex>;
  tagToDeckId: Record<string, string>;
}
