import { fsrs, createEmptyCard, generatorParameters, Rating as FsrsRating, Card as FsrsCard, FSRS } from 'ts-fsrs';
import { Scheduler } from '../domain/scheduler';
import { MemoryState } from '../domain/memory-state';
import { Rating } from '../domain/rating';

const RATING_MAP: Record<Rating, FsrsRating> = {
  [Rating.Again]: FsrsRating.Again,
  [Rating.Hard]: FsrsRating.Hard,
  [Rating.Good]: FsrsRating.Good,
  [Rating.Easy]: FsrsRating.Easy,
};

export class FsrsScheduler implements Scheduler {
  private readonly engine: FSRS;

  constructor() {
    this.engine = fsrs(generatorParameters());
  }

  schedule(currentState: MemoryState, rating: Rating, now: Date): MemoryState {
    const fsrsCard = this.toFsrsCard(currentState, now);
    const result = this.engine.repeat(fsrsCard, now);
    const scheduled = result[RATING_MAP[rating]];

    return new MemoryState(
      scheduled.card.stability,
      scheduled.card.difficulty,
      scheduled.card.due,
      scheduled.card.reps,
      scheduled.card.lapses,
      now,
    );
  }

  private toFsrsCard(state: MemoryState, now: Date): FsrsCard {
    if (state.reps === 0) {
      return createEmptyCard(now);
    }

    return {
      due: state.due,
      stability: state.stability,
      difficulty: state.difficulty,
      elapsed_days: state.lastReview
        ? Math.max(0, Math.floor((now.getTime() - state.lastReview.getTime()) / (1000 * 60 * 60 * 24)))
        : 0,
      scheduled_days: 0,
      reps: state.reps,
      lapses: state.lapses,
      state: state.reps === 0 ? 0 : 2, // 0 = New, 2 = Review
      last_review: state.lastReview ?? undefined,
    } as FsrsCard;
  }
}
