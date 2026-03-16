import { SessionId } from './session-id';
import { DeckId } from '@context/deck/domain/deck-id';
import { StudyItemId } from '@context/study/domain/study-item-id';
import { Rating } from '@context/study/domain/rating';
import { Review } from './review';

export class Session {
  private constructor(
    readonly id: SessionId,
    readonly deckId: DeckId,
    readonly startedAt: Date,
    private _endedAt: Date | null,
    private _reviews: Review[],
  ) {}

  static start(id: SessionId, deckId: DeckId, now: Date = new Date()): Session {
    return new Session(id, deckId, now, null, []);
  }

  static reconstitute(
    id: SessionId,
    deckId: DeckId,
    startedAt: Date,
    endedAt: Date | null,
    reviews: Review[],
  ): Session {
    return new Session(id, deckId, startedAt, endedAt, reviews);
  }

  get endedAt(): Date | null {
    return this._endedAt;
  }

  get isActive(): boolean {
    return this._endedAt === null;
  }

  get reviews(): readonly Review[] {
    return this._reviews;
  }

  get totalReviews(): number {
    return this._reviews.length;
  }

  addReview(studyItemId: StudyItemId, rating: Rating, now: Date = new Date()): void {
    if (!this.isActive) {
      throw new Error('Cannot add a review to an ended session');
    }
    this._reviews.push(new Review(studyItemId, rating, now));
  }

  end(now: Date = new Date()): void {
    if (!this.isActive) {
      throw new Error('Session is already ended');
    }
    this._endedAt = now;
  }

  countByRating(rating: Rating): number {
    return this._reviews.filter(r => r.rating === rating).length;
  }
}
