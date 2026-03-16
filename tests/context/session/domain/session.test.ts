import { describe, it, expect } from 'vitest';
import { Session } from '@context/session/domain/session';
import { SessionId } from '@context/session/domain/session-id';
import { DeckId } from '@context/deck/domain/deck-id';
import { StudyItemId } from '@context/study/domain/study-item-id';
import { Rating } from '@context/study/domain/rating';

describe('Session', () => {
  const sessionId = new SessionId(crypto.randomUUID());
  const deckId = new DeckId(crypto.randomUUID());
  const now = new Date();

  it('should start an active session', () => {
    const session = Session.start(sessionId, deckId, now);

    expect(session.id).toBe(sessionId);
    expect(session.deckId).toBe(deckId);
    expect(session.startedAt).toBe(now);
    expect(session.isActive).toBe(true);
    expect(session.endedAt).toBeNull();
    expect(session.totalReviews).toBe(0);
  });

  it('should add a review', () => {
    const session = Session.start(sessionId, deckId, now);
    const studyItemId = new StudyItemId(crypto.randomUUID());

    session.addReview(studyItemId, Rating.Good, now);

    expect(session.totalReviews).toBe(1);
    expect(session.reviews[0].studyItemId).toEqual(studyItemId);
    expect(session.reviews[0].rating).toBe(Rating.Good);
  });

  it('should add multiple reviews', () => {
    const session = Session.start(sessionId, deckId, now);

    session.addReview(new StudyItemId(crypto.randomUUID()), Rating.Good, now);
    session.addReview(new StudyItemId(crypto.randomUUID()), Rating.Again, now);
    session.addReview(new StudyItemId(crypto.randomUUID()), Rating.Easy, now);

    expect(session.totalReviews).toBe(3);
  });

  it('should count reviews by rating', () => {
    const session = Session.start(sessionId, deckId, now);

    session.addReview(new StudyItemId(crypto.randomUUID()), Rating.Good, now);
    session.addReview(new StudyItemId(crypto.randomUUID()), Rating.Again, now);
    session.addReview(new StudyItemId(crypto.randomUUID()), Rating.Good, now);
    session.addReview(new StudyItemId(crypto.randomUUID()), Rating.Hard, now);

    expect(session.countByRating(Rating.Good)).toBe(2);
    expect(session.countByRating(Rating.Again)).toBe(1);
    expect(session.countByRating(Rating.Hard)).toBe(1);
    expect(session.countByRating(Rating.Easy)).toBe(0);
  });

  it('should end a session', () => {
    const session = Session.start(sessionId, deckId, now);
    const endTime = new Date(now.getTime() + 1000 * 60 * 30);

    session.end(endTime);

    expect(session.isActive).toBe(false);
    expect(session.endedAt).toBe(endTime);
  });

  it('should not end an already ended session', () => {
    const session = Session.start(sessionId, deckId, now);
    session.end(now);

    expect(() => session.end(now)).toThrow('Session is already ended');
  });

  it('should not add reviews to an ended session', () => {
    const session = Session.start(sessionId, deckId, now);
    session.end(now);

    expect(() =>
      session.addReview(new StudyItemId(crypto.randomUUID()), Rating.Good, now),
    ).toThrow('Cannot add a review to an ended session');
  });
});
