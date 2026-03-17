import { StudyItemRepository } from '../domain/study-item-repository';
import { MemoryState } from '../domain/memory-state';
import { StudyItem } from '../domain/study-item';
import { StudyItemId } from '../domain/study-item-id';

export interface SrSchedule {
  due: string;      // YYYY-MM-DD
  interval: number; // days
  ease: number;     // 100-based (e.g. 250 = 2.5)
}

export class ImportSrData {
  constructor(
    private readonly studyItemRepository: StudyItemRepository,
  ) {}

  /**
   * Import SR scheduling into an existing StudyItem.
   * Only updates items with reps=0 (never reviewed in Recall).
   * Returns true if imported, false if skipped.
   */
  async execute(studyItemId: string, schedule: SrSchedule): Promise<boolean> {
    const item = await this.studyItemRepository.findById(new StudyItemId(studyItemId));
    if (!item) return false;

    // Already reviewed in Recall — don't overwrite
    if (item.memoryState.reps > 0) return false;

    const dueDate = new Date(schedule.due + 'T00:00:00');
    const lastReview = new Date(dueDate.getTime() - schedule.interval * 24 * 60 * 60 * 1000);

    // Convert SM-2 ease to FSRS approximation
    const easeFactor = schedule.ease / 100;
    const stability = Math.max(1, schedule.interval * (easeFactor / 2.5));
    const difficulty = Math.max(1, Math.min(10, 11 - easeFactor * 3));

    const reps = schedule.interval <= 1 ? 1
      : schedule.interval <= 7 ? 2
      : schedule.interval <= 21 ? 3
      : schedule.interval <= 60 ? 4
      : 5;

    const importedState = new MemoryState(
      stability, difficulty, dueDate, reps, 0, lastReview,
    );

    const updated = StudyItem.reconstitute(
      item.id, item.conceptId, item.direction, importedState,
    );

    await this.studyItemRepository.save(updated);
    return true;
  }
}
