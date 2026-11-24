import { StudyItem } from '../domain/study-item';
import { MemoryState } from '../domain/memory-state';
import { Review } from '../domain/review';
import type { Rating } from '../domain/rating';
import type { Scheduler } from '../domain/scheduler';
import type { StudyItemRepository } from '../domain/study-item-repository';
import type { LoggedReview, ReviewLog } from '../domain/review-log';

/** Only reviews from the last two days can be corrected (amended, removed or restored). */
export const CORRECTION_WINDOW_MS = 2 * 86_400_000;

export type ReviewCorrection =
  | { kind: 'amend'; reviewId: number; rating: Rating }
  | { kind: 'remove'; reviewId: number }
  /** Puts back a removed review (its id, rating, timestamp, origin and prior as they were when removed). */
  | { kind: 'restore'; entry: LoggedReview };

export type CorrectionFailure = 'not-found' | 'outside-window' | 'card-missing' | 'conflict' | 'unverifiable';
export class ReviewCorrectionError extends Error {
  constructor(readonly reason: CorrectionFailure, message: string) { super(message); }
}

export interface ReviewCorrectionOutcome {
  /** The corrected review as it was before the change (for a restore: the review put back). */
  target: LoggedReview;
  /** False when an amend asks for the rating the review already has: nothing is written. */
  changed: boolean;
  before: MemoryState;
  after: MemoryState;
  /** The card's history before and after the change (priors as stored then). */
  historyBefore: LoggedReview[];
  historyAfter: LoggedReview[];
}

const ms = (e: LoggedReview) => e.review.timestamp.getTime();
const withPrior = (e: LoggedReview, rating: Rating, prior: MemoryState): LoggedReview =>
  ({ id: e.id, review: new Review(e.review.studyItemId, rating, e.review.timestamp, e.review.origin, prior) });

/**
 * Changes a card's past: the rating of one review, its removal, or its restoration. The card's
 * memory state is then what it would have been had the history always been the corrected one: the
 * history is replayed (`StudyItem.replay`, as `CreateStudyItem` does for a recreated card) from the
 * state just before the change, and later reviews are re-applied in order, so a card reviewed again
 * after the corrected review is right too.
 *
 * The starting point is the stored `prior` of the nearest review at or before the change: for a
 * card whose history explains its state this equals replaying everything from scratch, and it also
 * holds for state imported without matching history. Reviews logged before priors were kept fall
 * back to a replay from scratch. Either way the start is first checked: replaying the CURRENT history
 * from it must reproduce the stored state exactly, or the correction is refused ('unverifiable')
 * instead of guessing.
 */
export class CorrectReview {
  constructor(
    private readonly repository: StudyItemRepository,
    private readonly scheduler: Scheduler,
    private readonly reviewLog: ReviewLog,
  ) {}

  async execute(correction: ReviewCorrection, now: Date = new Date()): Promise<ReviewCorrectionOutcome> {
    const target = correction.kind === 'restore' ? correction.entry : await this.reviewLog.findLogged(correction.reviewId);
    if (!target) throw new ReviewCorrectionError('not-found', `Review ${correction.kind === 'restore' ? correction.entry.id : correction.reviewId} not found`);
    if (ms(target) < now.getTime() - CORRECTION_WINDOW_MS) {
      throw new ReviewCorrectionError('outside-window', 'Only reviews from the last 2 days can be corrected');
    }
    const item = await this.repository.findById(target.review.studyItemId);
    if (!item) throw new ReviewCorrectionError('card-missing', 'The card of this review no longer exists');
    const old = await this.reviewLog.findLoggedByStudyItemId(target.review.studyItemId);
    const unchanged = { target, before: item.memoryState, after: item.memoryState, historyBefore: old, historyAfter: old };
    if (correction.kind === 'amend' && target.review.rating === correction.rating) return { ...unchanged, changed: false };

    let next: LoggedReview[];
    let position: number;
    if (correction.kind === 'restore') {
      if (old.some(e => e.id === target.id || ms(e) === ms(target))) {
        throw new ReviewCorrectionError('conflict', 'The card already has this review (or another one at the same instant)');
      }
      position = old.findIndex(e => ms(e) > ms(target));
      if (position < 0) position = old.length;
      next = [...old.slice(0, position), target, ...old.slice(position)];
    } else {
      position = old.findIndex(e => e.id === target.id);
      next = correction.kind === 'amend'
        ? old.map(e => e.id === target.id ? withPrior(e, correction.rating, e.review.prior as MemoryState) : e)
        : old.filter(e => e.id !== target.id);
    }

    // Where to start: [state, first timestamp to replay].
    let start: MemoryState, from: number;
    if (correction.kind === 'restore' && position === old.length) {
      start = item.memoryState; from = ms(target); // put back as the latest review: the current state is the state before it
    } else {
      let anchor = -1;
      for (let i = Math.min(position, old.length - 1); i >= 0; i--) if (old[i].review.prior) { anchor = i; break; }
      if (anchor >= 0) {
        start = old[anchor].review.prior!;
        from = correction.kind === 'restore' ? Math.min(ms(old[anchor]), ms(target)) : ms(old[anchor]);
      } else {
        start = MemoryState.initial(); from = -Infinity;
      }
      const check = StudyItem.reconstitute(item.id, item.conceptId, item.direction, start);
      check.replay(old.filter(e => ms(e) >= from).map(e => e.review), this.scheduler);
      if (!check.memoryState.equals(item.memoryState)) {
        throw new ReviewCorrectionError('unverifiable', 'This card\'s schedule is not explained by its review log (imported or changed outside it), so it cannot be recomputed safely');
      }
    }

    const tail = next.filter(e => ms(e) >= from);
    const rebuilt = StudyItem.reconstitute(item.id, item.conceptId, item.direction, start);
    const priors = rebuilt.replay(tail.map(e => e.review), this.scheduler);
    const replayed = tail.map((e, i) => withPrior(e, e.review.rating, priors[i]));

    if (correction.kind === 'remove') await this.reviewLog.removeById(target.id);
    for (const e of replayed) {
      if (e.id === target.id && correction.kind === 'restore') await this.reviewLog.restore(e);
      else await this.reviewLog.rewrite(e.id, e.review.rating, e.review.prior);
    }
    await this.repository.save(rebuilt);

    const byId = new Map(replayed.map(e => [e.id, e]));
    return {
      target, changed: true, before: item.memoryState, after: rebuilt.memoryState,
      historyBefore: old, historyAfter: next.map(e => byId.get(e.id) ?? e),
    };
  }
}
