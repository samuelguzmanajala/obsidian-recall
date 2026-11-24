import { Review } from './review';
import { StudyItemId } from './study-item-id';
import type { Rating } from './rating';
import type { MemoryState } from './memory-state';

/** A review as stored, with its log identity. Ids are positive integers and never reused. */
export interface LoggedReview {
  readonly id: number;
  readonly review: Review;
}

/** One review per (study item, timestamp); reads are ordered by timestamp, then by insertion. */
export interface ReviewLog {
  /** Returns the new review's id, or `null` when the same study item already has a review at that exact timestamp (ignored). */
  append(review: Review): Promise<number | null>;
  findByStudyItemId(studyItemId: StudyItemId): Promise<Review[]>;
  findAll(): Promise<Review[]>;
  findSince(since: Date): Promise<Review[]>;
  countSince(since: Date): Promise<number>;
  /** Study items whose first review ever is at or after `since`. */
  countFirstReviewedSince(since: Date): Promise<number>;

  // ---- Corrections (see CorrectReview) ----
  findLogged(id: number): Promise<LoggedReview | null>;
  /** A study item's history with ids, by timestamp then insertion. */
  findLoggedByStudyItemId(studyItemId: StudyItemId): Promise<LoggedReview[]>;
  /** Reviews at or after `since`, newest first (timestamp, then insertion, descending), at most `limit`. */
  findLatest(since: Date, limit: number): Promise<LoggedReview[]>;
  /** Replaces the rating and the prior state of a logged review; timestamp, origin and id stay. */
  rewrite(id: number, rating: Rating, prior: MemoryState | null): Promise<void>;
  removeById(id: number): Promise<void>;
  /** Puts back a removed review under its original id (which is never given to another review). */
  restore(entry: LoggedReview): Promise<void>;
}
