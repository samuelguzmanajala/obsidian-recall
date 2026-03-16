import { ConceptId } from '@context/concept/domain/concept-id';
import { StudyItemId } from './study-item-id';
import { MemoryState } from './memory-state';
import { Rating } from './rating';
import { Direction } from './direction';
import { Scheduler } from './scheduler';

export class StudyItem {
  private constructor(
    readonly id: StudyItemId,
    readonly conceptId: ConceptId,
    readonly direction: Direction,
    private _memoryState: MemoryState,
  ) {}

  static create(
    id: StudyItemId,
    conceptId: ConceptId,
    direction: Direction,
  ): StudyItem {
    return new StudyItem(id, conceptId, direction, MemoryState.initial());
  }

  static reconstitute(
    id: StudyItemId,
    conceptId: ConceptId,
    direction: Direction,
    memoryState: MemoryState,
  ): StudyItem {
    return new StudyItem(id, conceptId, direction, memoryState);
  }

  get memoryState(): MemoryState {
    return this._memoryState;
  }

  get isDue(): boolean {
    return this._memoryState.isDue;
  }

  review(rating: Rating, scheduler: Scheduler, now: Date = new Date()): void {
    this._memoryState = scheduler.schedule(this._memoryState, rating, now);
  }
}
