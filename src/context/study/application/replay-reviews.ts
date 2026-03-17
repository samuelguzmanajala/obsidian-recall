import { StudyItemRepository } from '../domain/study-item-repository';
import { StudyItemId } from '../domain/study-item-id';
import { ReviewLog } from '../domain/review-log';
import { Scheduler } from '../domain/scheduler';
import { MemoryState } from '../domain/memory-state';
import { Rating } from '../domain/rating';
import { StudyItem } from '../domain/study-item';

/**
 * Replays all reviews from the append-only log to reconstruct
 * the current MemoryState for every StudyItem.
 *
 * This is the core of the event-sourcing approach:
 * - reviews.json is the source of truth (append-only, sync-safe)
 * - study-items.json is a derived cache (reconstructible)
 *
 * Safe to run multiple times — idempotent.
 */
export class ReplayReviews {
  constructor(
    private readonly studyItemRepository: StudyItemRepository,
    private readonly reviewLog: ReviewLog,
    private readonly scheduler: Scheduler,
  ) {}

  /**
   * Replay all reviews and update MemoryState for each StudyItem.
   * Returns the number of items updated.
   */
  async execute(): Promise<number> {
    const allReviews = await this.reviewLog.findAll();
    if (allReviews.length === 0) return 0;

    // Group reviews by studyItemId, sorted by timestamp
    const reviewsByItem = new Map<string, { rating: string; timestamp: Date }[]>();
    for (const review of allReviews) {
      const id = review.studyItemId.value;
      const group = reviewsByItem.get(id) ?? [];
      group.push({ rating: review.rating, timestamp: review.timestamp });
      reviewsByItem.set(id, group);
    }

    // Sort each group by timestamp
    for (const group of reviewsByItem.values()) {
      group.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    }

    let updated = 0;

    for (const [itemId, reviews] of reviewsByItem) {
      const item = await this.studyItemRepository.findById(
        new StudyItemId(itemId),
      );
      if (!item) continue;

      // Start from initial state and replay each review
      let state = MemoryState.initial();
      for (const review of reviews) {
        state = this.scheduler.schedule(state, review.rating as Rating, review.timestamp);
      }

      // Only update if replay produces MORE reviews than current state.
      // This prevents overwriting imported SR data (which has higher reps)
      // with a replay that only knows about Recall reviews.
      if (state.reps > item.memoryState.reps) {
        const rebuilt = StudyItem.reconstitute(
          item.id, item.conceptId, item.direction, state,
        );
        await this.studyItemRepository.save(rebuilt);
        updated++;
      }
    }

    return updated;
  }
}
