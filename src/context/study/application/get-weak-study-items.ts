import { StudyItemRepository } from '../domain/study-item-repository';
import { ReviewLog } from '../domain/review-log';
import { Rating } from '../domain/rating';
import { Direction } from '../domain/direction';

export interface WeakStudyItemView {
  studyItemId: string;
  conceptId: string;
  direction: Direction;
  /** "Again" ratings within the window. */
  recentAgain: number;
  lapses: number;
  reps: number;
  /** FSRS difficulty, 1 (easy) – 10 (hard). */
  difficulty: number;
  /** FSRS stability in days. */
  stability: number;
  due: Date;
  lastReview: Date | null;
  /** Higher is shakier; see `weaknessScore`. */
  score: number;
}

/** FSRS difficulty from which a card counts as hard even without lapses (a first "Again" starts around 7). */
export const HARD_DIFFICULTY = 7;

/**
 * Heuristic, from data the scheduler already stores: recent failures weigh most, then lifetime
 * lapses, then FSRS difficulty above the midpoint, then a fragile memory (stability under 2 days).
 */
export function weaknessScore(recentAgain: number, lapses: number, difficulty: number, stability: number): number {
  return 3 * recentAgain + 2 * lapses + Math.max(0, difficulty - 5) + (stability < 2 ? 1 : 0);
}

/**
 * Studied cards the user struggles with, shakiest first: any "Again" within `windowDays`, at least
 * one lapse, or difficulty ≥ `HARD_DIFFICULTY`. Reads the study items and only the reviews of the
 * window (by time), never the whole log. Never-studied cards are not weak, just new.
 */
export class GetWeakStudyItems {
  constructor(
    private readonly studyItemRepository: StudyItemRepository,
    private readonly reviewLog: ReviewLog,
  ) {}

  async execute(now: Date = new Date(), windowDays = 30): Promise<WeakStudyItemView[]> {
    const since = new Date(now.getTime() - windowDays * 86_400_000);
    const again = new Map<string, number>();
    for (const review of await this.reviewLog.findSince(since)) {
      if (review.rating === Rating.Again && review.timestamp <= now) {
        again.set(review.studyItemId.value, (again.get(review.studyItemId.value) ?? 0) + 1);
      }
    }
    const views: WeakStudyItemView[] = [];
    for (const item of await this.studyItemRepository.findAll()) {
      const m = item.memoryState;
      const recentAgain = again.get(item.id.value) ?? 0;
      if (m.reps === 0 || (recentAgain === 0 && m.lapses === 0 && m.difficulty < HARD_DIFFICULTY)) continue;
      views.push({
        studyItemId: item.id.value, conceptId: item.conceptId.value, direction: item.direction,
        recentAgain, lapses: m.lapses, reps: m.reps, difficulty: m.difficulty, stability: m.stability,
        due: m.due, lastReview: m.lastReview,
        score: weaknessScore(recentAgain, m.lapses, m.difficulty, m.stability),
      });
    }
    // Stable sort: equal scores keep storage order after the tie-breakers.
    return views.sort((a, b) => b.score - a.score || b.recentAgain - a.recentAgain || b.lapses - a.lapses
      || (b.lastReview?.getTime() ?? 0) - (a.lastReview?.getTime() ?? 0));
  }
}
