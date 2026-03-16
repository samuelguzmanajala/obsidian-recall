import { describe, it, expect } from 'vitest';
import { FsrsScheduler } from '@context/study/infrastructure/fsrs-scheduler';
import { MemoryState } from '@context/study/domain/memory-state';
import { Rating } from '@context/study/domain/rating';

describe('FsrsScheduler', () => {
  const scheduler = new FsrsScheduler();
  const now = new Date('2026-03-16T12:00:00Z');

  describe('first review (new card)', () => {
    const initial = MemoryState.initial();

    it('should schedule a new card after Good rating', () => {
      const result = scheduler.schedule(initial, Rating.Good, now);

      expect(result.reps).toBe(1);
      expect(result.lapses).toBe(0);
      expect(result.stability).toBeGreaterThan(0);
      expect(result.difficulty).toBeGreaterThan(0);
      expect(result.due.getTime()).toBeGreaterThan(now.getTime());
      expect(result.lastReview).toBe(now);
    });

    it('should schedule shorter interval for Again than Good', () => {
      const again = scheduler.schedule(initial, Rating.Again, now);
      const good = scheduler.schedule(initial, Rating.Good, now);

      expect(again.due.getTime()).toBeLessThanOrEqual(good.due.getTime());
    });

    it('should schedule longer interval for Easy than Good', () => {
      const good = scheduler.schedule(initial, Rating.Good, now);
      const easy = scheduler.schedule(initial, Rating.Easy, now);

      expect(easy.due.getTime()).toBeGreaterThanOrEqual(good.due.getTime());
    });

    it('should increase difficulty on Again', () => {
      const again = scheduler.schedule(initial, Rating.Again, now);
      const easy = scheduler.schedule(initial, Rating.Easy, now);

      expect(again.difficulty).toBeGreaterThan(easy.difficulty);
    });
  });

  describe('subsequent reviews', () => {
    it('should increase stability after consecutive Good ratings with real interval', () => {
      const initial = MemoryState.initial();
      const firstReview = scheduler.schedule(initial, Rating.Good, now);

      // Wait until after the due date (simulate days passing)
      const daysLater = new Date(firstReview.due.getTime() + 1000 * 60 * 60 * 24);
      const secondReview = scheduler.schedule(firstReview, Rating.Good, daysLater);

      expect(secondReview.stability).toBeGreaterThanOrEqual(firstReview.stability);
      expect(secondReview.reps).toBe(2);
    });

    it('should increase lapses on Again for reviewed card', () => {
      const initial = MemoryState.initial();
      const firstReview = scheduler.schedule(initial, Rating.Good, now);

      const laterDate = new Date(firstReview.due.getTime() + 1000 * 60);
      const lapsed = scheduler.schedule(firstReview, Rating.Again, laterDate);

      expect(lapsed.lapses).toBe(1);
    });
  });
});
