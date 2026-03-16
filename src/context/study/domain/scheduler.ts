import { MemoryState } from './memory-state';
import { Rating } from './rating';

export interface SchedulePreview {
  rating: Rating;
  nextDue: Date;
  intervalDays: number;
}

export interface Scheduler {
  schedule(currentState: MemoryState, rating: Rating, now: Date): MemoryState;
  previewAll(currentState: MemoryState, now: Date): SchedulePreview[];
}
