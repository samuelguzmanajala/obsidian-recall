import { StudyItem } from '../domain/study-item';
import { StudyItemId } from '../domain/study-item-id';
import { StudyItemRepository } from '../domain/study-item-repository';
import { ConceptId } from '@context/concept/domain/concept-id';
import { Direction } from '../domain/direction';
import { ReviewLog } from '../domain/review-log';
import { Scheduler } from '../domain/scheduler';

export interface CreateStudyItemCommand {
  id: string;
  conceptId: string;
  direction: Direction;
}

export class CreateStudyItem {
  constructor(
    private readonly repository: StudyItemRepository,
    private readonly reviewLog: ReviewLog | null = null,
    private readonly scheduler: Scheduler | null = null,
  ) {}

  /**
   * Create a StudyItem with the given ID. Two safety nets to ensure progress
   * is never silently lost:
   *
   * 1. **Idempotency**: if a StudyItem with this ID already exists, keep
   *    the existing one. Overwriting would erase its MemoryState.
   *
   * 2. **Auto-replay**: if the item doesn't exist BUT historical reviews
   *    for this ID exist in the log, create the item and immediately
   *    replay those reviews to reconstruct its state. This covers the
   *    case where the note indexer deleted the item (e.g., during a card edit
   *    cycle) and is now recreating it. IDs are content-derived, so the
   *    same content always resurfaces with the same ID — and now also
   *    with its full history intact.
   */
  async execute(command: CreateStudyItemCommand): Promise<void> {
    const id = new StudyItemId(command.id);
    const existing = await this.repository.findById(id);
    if (existing) return;

    const studyItem = StudyItem.create(
      id,
      new ConceptId(command.conceptId),
      command.direction,
    );

    // If the review log + scheduler are wired, reconstruct any prior state
    // by replaying historical reviews for this exact ID.
    if (this.reviewLog && this.scheduler) {
      const history = await this.reviewLog.findByStudyItemId(id);
      if (history.length > 0) {
        const sorted = [...history].sort(
          (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
        );
        for (const review of sorted) {
          studyItem.review(review.rating, this.scheduler, review.timestamp);
        }
      }
    }

    await this.repository.save(studyItem);
  }
}
