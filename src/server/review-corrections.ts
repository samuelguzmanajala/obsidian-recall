import { ApiError, type RecallService } from './service';
import type { Container } from './container';
import { Review, type ReviewOrigin } from '../context/study/domain/review';
import type { Rating } from '../context/study/domain/rating';
import type { LoggedReview } from '../context/study/domain/review-log';
import { StudyItemId } from '../context/study/domain/study-item-id';
import { Direction } from '../context/study/domain/direction';
import { CORRECTION_WINDOW_MS, ReviewCorrectionError, type ReviewCorrection, type ReviewCorrectionOutcome } from '../context/study/application/correct-review';
import { parsePrior, priorJson } from './persistence/sqlite-repositories';

export type ChangeAction = 'amend' | 'remove' | 'restore';
type Row = Record<string, unknown>;

/** A card as shown next to a review: the side asked and the side recalled (raw Markdown; `null` if the card is gone). */
export interface CardText { prompt: string | null; answer: string | null }

export interface ChangeResult {
  changeId: number | null;
  reviewId: number;
  studyItemId: string;
  action: ChangeAction | null;
  from: Rating | null;
  to: Rating | null;
  /** The card's due time after the change. */
  due: Date | null;
  /** True when the same change had already been made (a retried call): nothing new was written. */
  already?: true;
}

const dayStart = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
/** Whether a review consumed the daily "new" allowance (as `RecallService.review` counted it) or the "review" one. */
const introduces = (e: LoggedReview, index: number) => e.review.prior ? e.review.prior.reps === 0 : index === 0;

/**
 * Corrections of recent reviews (amend the rating, remove, revert a correction), one transaction
 * each, on top of the kernel's `CorrectReview` (which recomputes the card). Here: the audit trail
 * (`review_changes`), daily counters and item revisions.
 *
 * - Every applied change is one audit row: the review (id, card, time, origin), the action, the
 *   ratings before/after, who made the change and when, and for a removal the review's prior state,
 *   so it can be put back exactly. Reverting a change is itself a change (`reverts` = its id).
 * - Counters: a removed review gives back the daily allowance it used on its day; a restored one
 *   takes it again; if a removal makes a later review the card's first, that one moves from
 *   "reviewed" to "introduced". Amending never changes counts. Only days that have a stored counter
 *   row are adjusted (without one, the counters are derived from the log, which is already right).
 * - The card's revision is bumped, so a client holding it in its queue gets 409 and refreshes.
 */
export class ReviewCorrections {
  constructor(private readonly service: RecallService) {}

  private get db() { return this.service.db; }

  amend(reviewId: number, rating: Rating, origin: ReviewOrigin): Promise<ChangeResult> {
    return this.db.transaction(async () => {
      const c = this.service.container;
      return this.apply(c, { kind: 'amend', reviewId, rating }, origin, null);
    });
  }

  remove(reviewId: number, origin: ReviewOrigin): Promise<ChangeResult> {
    return this.db.transaction(async () => {
      const c = this.service.container;
      if (!await c.reviewLog.findLogged(reviewId)) {
        // A retried removal: the review is gone because of the latest change to it.
        const last = this.db.stmt('SELECT * FROM review_changes WHERE review_id=? ORDER BY id DESC LIMIT 1').get(reviewId);
        if (last && last.action === 'remove') return { ...this.view(last), due: await this.dueOf(c, last.study_item_id as string), already: true };
      }
      return this.apply(c, { kind: 'remove', reviewId }, origin, null);
    });
  }

  /** Undoes one change: an amend goes back to its old rating, a removal is restored, a restore is removed again. */
  revert(changeId: number, origin: ReviewOrigin): Promise<ChangeResult> {
    return this.db.transaction(async () => {
      const c = this.service.container;
      const change = this.db.stmt('SELECT * FROM review_changes WHERE id=?').get(changeId);
      if (!change) throw new ApiError(404, `Change ${changeId} not found`);
      const done = this.db.stmt('SELECT * FROM review_changes WHERE reverts=?').get(changeId);
      if (done) return { ...this.view(done), due: await this.dueOf(c, done.study_item_id as string), already: true };
      const reviewId = Number(change.review_id);
      const later = this.db.stmt('SELECT id FROM review_changes WHERE review_id=? AND id>? ORDER BY id DESC LIMIT 1').get(reviewId, changeId);
      if (later) throw new ApiError(409, `Review ${reviewId} was changed again afterwards (change ${later.id}); revert that change first`);
      switch (change.action as ChangeAction) {
        case 'amend':
          return this.apply(c, { kind: 'amend', reviewId, rating: change.old_rating as Rating }, origin, changeId);
        case 'restore':
          return this.apply(c, { kind: 'remove', reviewId }, origin, changeId);
        case 'remove': {
          const review = new Review(new StudyItemId(change.study_item_id as string), change.old_rating as Rating,
            new Date(change.review_timestamp as number), (change.review_origin ?? null) as ReviewOrigin | null, parsePrior(change.prior as string | null));
          return this.apply(c, { kind: 'restore', entry: { id: reviewId, review } }, origin, changeId);
        }
        default: throw new Error(`Unknown change action ${String(change.action)}`);
      }
    });
  }

  /** Reviews at or after `since`, newest first, with their card and the rating they were first recorded with if it was amended since. */
  async recent(c: Container, since: Date, limit: number) {
    const reviews = [];
    for (const e of await c.reviewLog.findLatest(since, limit)) {
      const first = this.db.stmt("SELECT old_rating FROM review_changes WHERE review_id=? AND action='amend' ORDER BY id LIMIT 1").get(e.id);
      reviews.push({ entry: e, card: await this.cardText(c, e.review.studyItemId.value), originalRating: first && first.old_rating !== e.review.rating ? first.old_rating as Rating : null });
    }
    return reviews;
  }

  /** Corrections made at or after `since`, newest first, with whether each was reverted. */
  async changes(c: Container, since: Date, limit: number) {
    const rows = this.db.stmt('SELECT * FROM review_changes WHERE at>=? ORDER BY id DESC LIMIT ?').all(since.getTime(), limit);
    const out = [];
    for (const row of rows) {
      const revertedBy = this.db.stmt('SELECT id FROM review_changes WHERE reverts=?').get(row.id as number);
      out.push({ ...this.view(row), at: new Date(row.at as number), reverts: row.reverts === null ? null : Number(row.reverts),
        revertedBy: revertedBy ? Number(revertedBy.id) : null, card: await this.cardText(c, row.study_item_id as string),
        reviewedAt: new Date(row.review_timestamp as number), origin: (row.origin ?? null) as string | null });
    }
    return out;
  }

  async cardText(c: Container, studyItemId: string): Promise<CardText> {
    const item = await c.studyItemRepository.findById(new StudyItemId(studyItemId));
    const concept = item && await c.conceptRepository.findById(item.conceptId);
    if (!item || !concept) return { prompt: null, answer: null };
    const aToB = item.direction === Direction.AtoB;
    return { prompt: aToB ? concept.sideA.content : concept.sideB.content, answer: aToB ? concept.sideB.content : concept.sideA.content };
  }

  private async dueOf(c: Container, studyItemId: string): Promise<Date | null> {
    return (await c.studyItemRepository.findById(new StudyItemId(studyItemId)))?.memoryState.due ?? null;
  }

  private view(row: Row): Omit<ChangeResult, 'due'> {
    return {
      changeId: Number(row.id), reviewId: Number(row.review_id), studyItemId: row.study_item_id as string, action: row.action as ChangeAction,
      from: (row.old_rating ?? null) as Rating | null, to: (row.new_rating ?? null) as Rating | null,
    };
  }

  private async apply(c: Container, correction: ReviewCorrection, origin: ReviewOrigin, reverts: number | null): Promise<ChangeResult> {
    let outcome: ReviewCorrectionOutcome;
    try { outcome = await c.correctReview.execute(correction, new Date()); }
    catch (e) {
      if (e instanceof ReviewCorrectionError) throw new ApiError(e.reason === 'not-found' ? 404 : 409, e.message);
      throw e;
    }
    const { target } = outcome;
    const studyItemId = target.review.studyItemId.value;
    if (!outcome.changed) {
      return { changeId: null, reviewId: target.id, studyItemId, action: null, from: target.review.rating, to: target.review.rating, due: outcome.after.due };
    }
    this.adjustCounters(outcome);
    this.service.bumpRevisionOf(studyItemId);
    const action: ChangeAction = correction.kind;
    const from = correction.kind === 'restore' ? null : target.review.rating;
    const to = correction.kind === 'amend' ? correction.rating : correction.kind === 'restore' ? target.review.rating : null;
    const row = this.db.stmt(`INSERT INTO review_changes (review_id, study_item_id, review_timestamp, review_origin, action, old_rating, new_rating,
      prior, reverts, at, origin) VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).get(
      target.id, studyItemId, target.review.timestamp.getTime(), target.review.origin, action, from, to,
      correction.kind === 'remove' ? priorJson(target.review.prior) : null, reverts, Date.now(), origin)!;
    return { changeId: Number(row.id), reviewId: target.id, studyItemId, action, from, to, due: outcome.after.due };
  }

  private adjustCounters(outcome: ReviewCorrectionOutcome) {
    const delta = new Map<number, { introduced: number; reviewed: number }>();
    const tally = (history: LoggedReview[], sign: number) => history.forEach((e, i) => {
      const day = dayStart(e.review.timestamp.getTime());
      const d = delta.get(day) ?? { introduced: 0, reviewed: 0 };
      if (introduces(e, i)) d.introduced += sign; else d.reviewed += sign;
      delta.set(day, d);
    });
    tally(outcome.historyBefore, -1);
    tally(outcome.historyAfter, +1);
    for (const [day, d] of delta) {
      if (!d.introduced && !d.reviewed) continue;
      this.db.stmt('UPDATE daily_budgets SET introduced=MAX(0, introduced+?), reviewed=MAX(0, reviewed+?) WHERE day_start=?').run(d.introduced, d.reviewed, day);
    }
  }
}

export { CORRECTION_WINDOW_MS };
