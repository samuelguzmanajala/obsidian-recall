import { MemoryState } from './memory-state';
import { Rating } from './rating';

export interface Scheduler {
  schedule(currentState: MemoryState, rating: Rating, now: Date): MemoryState;
}
