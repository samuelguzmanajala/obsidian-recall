import type { DueStudyItemView } from '@context/study/application/study-item-view';
import type { DeckTreeNode } from '@context/deck/application/get-deck-tree';
import type { StudyStats } from '@context/study/application/get-study-stats';
import type { LeechView } from '@context/study/application/get-leeches';
import type { Rating } from '@context/study/domain/rating';

export interface ReviewCommand {
  studyItemId: string;
  rating: Rating;
  /** Revision the card had when it was shown; the backend rejects stale reviews. */
  expectedRevision?: number;
}

export interface SourceLocation { filePath: string; line: number }

/** What the Recall views need from the backend. `RemoteClient` implements it over HTTP. */
export interface StudyClient {
  /** False until the backend URL and token are set (they apply after a plugin reload). */
  isConfigured(): boolean;
  /** Subscribe to "data may have changed" notifications. Returns the unsubscribe function. */
  onChange(listener: () => void): () => void;
  /** A review was sent but its acknowledgement has not been confirmed yet. */
  hasPendingReview(): boolean;
  /** Re-send unacknowledged reviews with their original operation IDs. */
  retryPendingReviews(): Promise<void>;

  /** Server-ordered queue: limits, shuffling and interval previews are applied by the backend. */
  getDueStudyItems: { execute(): Promise<DueStudyItemView[]> };
  getDueStudyItemsByDeck: { execute(deckId: string): Promise<DueStudyItemView[]> };
  getDeckTree: { execute(): Promise<DeckTreeNode[]> };
  getStudyStats: { execute(): Promise<StudyStats> };
  /** Uses the leech threshold configured on the server. */
  getLeeches: { execute(): Promise<LeechView[]> };
  reviewStudyItem: { execute(command: ReviewCommand): Promise<void> };

  /** Note and line a concept was parsed from, as last reported by the backend. */
  findSource(conceptId: string): SourceLocation | null;

  /** Sidebar state, persisted with the plugin settings. */
  readonly expandedDeckIds: readonly string[];
  toggleDeckExpanded(deckId: string): void;
}
