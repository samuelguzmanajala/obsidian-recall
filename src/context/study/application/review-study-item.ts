import { StudyItemId } from '../domain/study-item-id';
import { Rating } from '../domain/rating';
import { Scheduler } from '../domain/scheduler';
import { StudyItemRepository } from '../domain/study-item-repository';
import { ReviewLog } from '../domain/review-log';
import { Review } from '../domain/review';

export interface ReviewStudyItemCommand {
  studyItemId: string;
  rating: Rating;
}

export class ReviewStudyItem {
  constructor(
    private readonly repository: StudyItemRepository,
    private readonly scheduler: Scheduler,
    private readonly reviewLog: ReviewLog,
  ) {}

  async execute(command: ReviewStudyItemCommand): Promise<void> {
    const now = new Date();
    const studyItemId = new StudyItemId(command.studyItemId);

    const studyItem = await this.repository.findById(studyItemId);
    if (!studyItem) {
      throw new Error(`StudyItem not found: ${command.studyItemId}`);
    }

    studyItem.review(command.rating, this.scheduler, now);
    await this.repository.save(studyItem);

    await this.reviewLog.append(new Review(studyItemId, command.rating, now));
  }
}
