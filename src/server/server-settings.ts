/** Scheduling configuration of the backend, read from environment variables in `main.ts`. */
export interface ServerSettings {
  /** Tags to track for flashcards. Empty = track ALL notes with cards. */
  flashcardTags: string[];
  /** Max new cards per day. 0 = unlimited. */
  dailyNewLimit: number;
  /** Max reviews per day. 0 = unlimited. */
  dailyReviewLimit: number;
  /** Leech threshold — items with this many lapses are marked as leeches. */
  leechThreshold: number;
  /** Shuffle the due queue. */
  shuffleReviews: boolean;
}

export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  flashcardTags: [],
  dailyNewLimit: 20,
  dailyReviewLimit: 0,
  leechThreshold: 8,
  shuffleReviews: true,
};
