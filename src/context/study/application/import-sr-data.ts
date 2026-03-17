import { StudyItemId } from '../domain/study-item-id';
import { ReviewLog } from '../domain/review-log';
import { Review } from '../domain/review';
import { Rating } from '../domain/rating';

export interface SrSchedule {
  due: string;      // YYYY-MM-DD
  interval: number; // days
  ease: number;     // 100-based (e.g. 250 = 2.5)
}

export class ImportSrData {
  constructor(
    private readonly reviewLog: ReviewLog,
  ) {}

  /**
   * Import SR scheduling by generating synthetic reviews.
   * Creates "Good" reviews spread over time to approximate the SR history.
   * The replay will then reconstruct the correct MemoryState via FSRS.
   *
   * Returns true if reviews were generated, false if skipped.
   */
  async execute(studyItemId: string, schedule: SrSchedule): Promise<boolean> {
    if (schedule.interval <= 0) return false;

    const studyItemIdObj = new StudyItemId(studyItemId);

    // Check if we already have reviews for this item (avoid duplicate import)
    const existing = await this.reviewLog.findByStudyItemId(studyItemIdObj);
    if (existing.length > 0) return false;

    // Generate synthetic reviews working backwards from the due date.
    // Each "Good" review roughly doubles the interval in FSRS,
    // so we create reviews at exponentially decreasing intervals.
    const dueDate = new Date(schedule.due + 'T00:00:00');
    const lastReviewDate = new Date(dueDate.getTime() - schedule.interval * 24 * 60 * 60 * 1000);

    // Estimate number of reviews from interval
    const numReviews = schedule.interval <= 1 ? 1
      : schedule.interval <= 7 ? 2
      : schedule.interval <= 21 ? 3
      : schedule.interval <= 60 ? 4
      : 5;

    // Spread reviews backwards from lastReviewDate
    const totalDays = Math.max(numReviews, schedule.interval);
    const reviews: Review[] = [];

    for (let i = 0; i < numReviews; i++) {
      // Exponential spacing: first review is earliest, last is most recent
      const fraction = i / Math.max(1, numReviews - 1);
      const daysBack = Math.round(totalDays * (1 - fraction));
      const timestamp = new Date(lastReviewDate.getTime() - daysBack * 24 * 60 * 60 * 1000);

      // Use "Good" for most, "Hard" for low ease items
      const rating = schedule.ease < 200 ? Rating.Hard : Rating.Good;

      reviews.push(new Review(studyItemIdObj, rating, timestamp));
    }

    // Append all synthetic reviews
    for (const review of reviews) {
      await this.reviewLog.append(review);
    }

    return true;
  }
}
