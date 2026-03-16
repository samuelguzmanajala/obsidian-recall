import { describe, it, expect } from 'vitest';
import { Review } from '@context/study/domain/review';
import { StudyItemId } from '@context/study/domain/study-item-id';
import { Rating } from '@context/study/domain/rating';

describe('Review', () => {
  const studyItemId = new StudyItemId(crypto.randomUUID());
  const now = new Date();

  it('should create a review', () => {
    const review = new Review(studyItemId, Rating.Good, now);

    expect(review.studyItemId).toBe(studyItemId);
    expect(review.rating).toBe(Rating.Good);
    expect(review.timestamp).toBe(now);
  });

  it('should be equal when all fields match', () => {
    const a = new Review(studyItemId, Rating.Good, now);
    const b = new Review(studyItemId, Rating.Good, now);

    expect(a.equals(b)).toBe(true);
  });

  it('should not be equal when rating differs', () => {
    const a = new Review(studyItemId, Rating.Good, now);
    const b = new Review(studyItemId, Rating.Hard, now);

    expect(a.equals(b)).toBe(false);
  });
});
