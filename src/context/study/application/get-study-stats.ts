import { StudyItemRepository } from '../domain/study-item-repository';
import { ReviewLog } from '../domain/review-log';

export interface StudyStats {
  totalItems: number;
  dueNow: number;
  newItems: number;       // reps === 0
  learningItems: number;  // reps > 0 && reps < 3
  matureItems: number;    // reps >= 3
  reviewsToday: number;
}

export class GetStudyStats {
  constructor(
    private readonly studyItemRepository: StudyItemRepository,
    private readonly reviewLog: ReviewLog,
  ) {}

  async execute(now: Date = new Date()): Promise<StudyStats> {
    const allItems = await this.studyItemRepository.findAll();
    const dueItems = allItems.filter(item => item.memoryState.due <= now);

    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const todayReviews = await this.reviewLog.findSince(startOfDay);

    let newItems = 0;
    let learningItems = 0;
    let matureItems = 0;

    for (const item of allItems) {
      if (item.memoryState.reps === 0) {
        newItems++;
      } else if (item.memoryState.reps < 3) {
        learningItems++;
      } else {
        matureItems++;
      }
    }

    return {
      totalItems: allItems.length,
      dueNow: dueItems.length,
      newItems,
      learningItems,
      matureItems,
      reviewsToday: todayReviews.length,
    };
  }
}
