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

/** Study settings of the backend (`GET/POST /api/v1/settings`). 0 = unlimited for the daily limits. */
export interface StudySettings {
  /** Tags to follow; a tag covers its sub-tags. Empty = every note with cards. */
  flashcardTags: string[];
  dailyNewLimit: number;
  dailyReviewLimit: number;
  leechThreshold: number;
  shuffleReviews: boolean;
}
export interface StudySettingsState {
  settings: StudySettings;
  /** `environment`: nothing stored yet (or reset); the server's environment values apply. */
  source: 'stored' | 'environment';
  revision: number;
}
export interface SettingsImpact {
  /** Published notes re-indexed (0 when the tag list did not change). */
  notes: number;
  cardsBefore: number; cardsAfter: number; cardsAdded: number; cardsRemoved: number;
  /** Decks holding at least one card. */
  decksBefore: number; decksAfter: number;
}
export interface SettingsUpdateResult extends StudySettingsState { impact: SettingsImpact; dryRun?: boolean }
export interface SettingsUpdate {
  operationId: string;
  expectedRevision: number;
  /** Fields to change; or `reset: true` to go back to the environment values. */
  settings?: Partial<StudySettings>;
  reset?: boolean;
  /** Compute the impact and persist nothing. */
  dryRun?: boolean;
}
/** `notes`/`cards`: what following the tag covers (itself and its sub-tags), whatever the current filter. */
export interface TagSummary { tag: string; notes: number; cards: number; selected: boolean; followed: boolean }
export interface TagListing { tags: TagSummary[]; untagged: { notes: number; cards: number; followed: boolean } }

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

  /** Study settings and tags the backend knows (settings tab). */
  getStudySettings(): Promise<StudySettingsState>;
  getTags(): Promise<TagListing>;
  /** Rejects with status 409 when `expectedRevision` is stale. */
  updateStudySettings(command: SettingsUpdate): Promise<SettingsUpdateResult>;

  /** Note and line a concept was parsed from, as last reported by the backend. */
  findSource(conceptId: string): SourceLocation | null;

  /** Sidebar state, persisted with the plugin settings. */
  readonly expandedDeckIds: readonly string[];
  toggleDeckExpanded(deckId: string): void;
}
