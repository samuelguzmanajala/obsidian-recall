import { Review } from './review';
import { StudyItemId } from './study-item-id';

/** One review per (study item, timestamp); reads are ordered by timestamp, then by insertion. */
export interface ReviewLog {
  /** Ignored when the same study item already has a review at that exact timestamp. */
  append(review: Review): Promise<void>;
  findByStudyItemId(studyItemId: StudyItemId): Promise<Review[]>;
  findAll(): Promise<Review[]>;
  findSince(since: Date): Promise<Review[]>;
  countSince(since: Date): Promise<number>;
  /** Study items whose first review ever is at or after `since`. */
  countFirstReviewedSince(since: Date): Promise<number>;
}
