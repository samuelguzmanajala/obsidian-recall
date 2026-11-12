import { StudyItemId } from '../domain/study-item-id';
import { Rating } from '../domain/rating';
import { Scheduler } from '../domain/scheduler';
import { StudyItemRepository } from '../domain/study-item-repository';
import { ReviewLog } from '../domain/review-log';
import { Review, type ReviewOrigin } from '../domain/review';
import type { MemoryState } from '../domain/memory-state';

export interface ReviewStudyItemCommand {
  expectedRevision?: number;
  studyItemId: string;
  rating: Rating;
  origin?: ReviewOrigin;
}

export interface ReviewStudyItemResult {
  /** Log id of the new review (`null` only if one already existed at this exact millisecond). */
  reviewId: number | null;
  memoryState: MemoryState;
}

export class ReviewStudyItem {
  constructor(
    private readonly repository: StudyItemRepository,
    private readonly scheduler: Scheduler,
    private readonly reviewLog: ReviewLog,
  ) {}

  async execute(command: ReviewStudyItemCommand): Promise<ReviewStudyItemResult> {
    const now = new Date();
    const studyItemId = new StudyItemId(command.studyItemId);

    const studyItem = await this.repository.findById(studyItemId);
    if (!studyItem) {
      throw new Error(`StudyItem not found: ${command.studyItemId}`);
    }

    const prior = studyItem.memoryState;
    studyItem.review(command.rating, this.scheduler, now);
    await this.repository.save(studyItem);

    const reviewId = await this.reviewLog.append(new Review(studyItemId, command.rating, now, command.origin ?? null, prior));
    return { reviewId: reviewId ?? null, memoryState: studyItem.memoryState };
  }
}
