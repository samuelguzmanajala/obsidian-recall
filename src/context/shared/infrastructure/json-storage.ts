export interface StorageData {
  concepts: Record<string, SerializedConcept>;
  studyItems: Record<string, SerializedStudyItem>;
  decks: Record<string, SerializedDeck>;
  reviews: SerializedReview[];
}

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

export interface JsonStoragePort {
  load(): Promise<StorageData>;
  save(data: StorageData): Promise<void>;
}

export function emptyStorageData(): StorageData {
  return {
    concepts: {},
    studyItems: {},
    decks: {},
    reviews: [],
  };
}
