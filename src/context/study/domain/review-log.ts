import { Review } from './review';
import { StudyItemId } from './study-item-id';

export interface ReviewLog {
  append(review: Review): Promise<void>;
  findByStudyItemId(studyItemId: StudyItemId): Promise<Review[]>;
  findAll(): Promise<Review[]>;
  findSince(since: Date): Promise<Review[]>;
}
