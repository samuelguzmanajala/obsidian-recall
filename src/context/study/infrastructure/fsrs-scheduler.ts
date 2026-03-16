import { fsrs, createEmptyCard, generatorParameters, Rating as FsrsRating, type Card as FsrsCard, type FSRS, type Grade as FsrsGrade } from 'ts-fsrs';
import { Scheduler, SchedulePreview } from '../domain/scheduler';
import { MemoryState } from '../domain/memory-state';
import { Rating } from '../domain/rating';

const RATING_MAP: Record<Rating, FsrsGrade> = {
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
    const fsrsGrade = RATING_MAP[rating];
    const scheduled = this.engine.next(fsrsCard, now, fsrsGrade);

    return new MemoryState(
      scheduled.card.stability,
      scheduled.card.difficulty,
      scheduled.card.due,
      scheduled.card.reps,
      scheduled.card.lapses,
      now,
    );
  }

  previewAll(currentState: MemoryState, now: Date): SchedulePreview[] {
    const ratings = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];
    return ratings.map(rating => {
      const next = this.schedule(currentState, rating, now);
      const intervalMs = next.due.getTime() - now.getTime();
      const intervalDays = Math.max(0, Math.round(intervalMs / (1000 * 60 * 60 * 24)));
      return { rating, nextDue: next.due, intervalDays };
    });
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
      state: state.lapses > 0 && state.reps < 3 ? 3 : 2,
      last_review: state.lastReview ?? undefined,
    } as FsrsCard;
  }
}
