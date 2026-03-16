import { describe, it, expect } from 'vitest';
import { StudyItem } from '@context/study/domain/study-item';
import { StudyItemId } from '@context/study/domain/study-item-id';
import { ConceptId } from '@context/concept/domain/concept-id';
import { Direction } from '@context/study/domain/direction';
import { Rating } from '@context/study/domain/rating';
import { MemoryState } from '@context/study/domain/memory-state';
import { Scheduler } from '@context/study/domain/scheduler';

const fakeScheduler: Scheduler = {
  schedule(currentState: MemoryState, rating: Rating, now: Date): MemoryState {
    const nextDue = new Date(now.getTime() + 1000 * 60 * 60 * 24); // +1 day
    return new MemoryState(
      currentState.stability + 1,
      rating === Rating.Again ? currentState.difficulty + 1 : currentState.difficulty,
      nextDue,
      currentState.reps + 1,
      rating === Rating.Again ? currentState.lapses + 1 : currentState.lapses,
      now,
    );
  },
};

describe('StudyItem', () => {
  const id = new StudyItemId(crypto.randomUUID());
  const conceptId = new ConceptId(crypto.randomUUID());

  it('should create with initial memory state', () => {
    const item = StudyItem.create(id, conceptId, Direction.AtoB);

    expect(item.id).toBe(id);
    expect(item.conceptId).toBe(conceptId);
    expect(item.direction).toBe(Direction.AtoB);
    expect(item.memoryState.reps).toBe(0);
    expect(item.memoryState.lapses).toBe(0);
  });

  it('should be due immediately after creation', () => {
    const item = StudyItem.create(id, conceptId, Direction.AtoB);

    expect(item.isDue).toBe(true);
  });

  it('should update memory state after a review', () => {
    const item = StudyItem.create(id, conceptId, Direction.AtoB);
    const now = new Date();

    item.review(Rating.Good, fakeScheduler, now);

    expect(item.memoryState.reps).toBe(1);
    expect(item.memoryState.lapses).toBe(0);
    expect(item.memoryState.stability).toBe(1);
    expect(item.memoryState.lastReview).toBe(now);
  });

  it('should increase lapses on Again rating', () => {
    const item = StudyItem.create(id, conceptId, Direction.AtoB);

    item.review(Rating.Again, fakeScheduler, new Date());

    expect(item.memoryState.lapses).toBe(1);
    expect(item.memoryState.difficulty).toBe(1);
  });

  it('should not be due after a review', () => {
    const item = StudyItem.create(id, conceptId, Direction.AtoB);

    item.review(Rating.Good, fakeScheduler, new Date());

    expect(item.isDue).toBe(false);
  });

  it('should reconstitute from existing state', () => {
    const memoryState = new MemoryState(5, 3, new Date(), 10, 2, new Date());
    const item = StudyItem.reconstitute(id, conceptId, Direction.BtoA, memoryState);

    expect(item.memoryState.reps).toBe(10);
    expect(item.memoryState.lapses).toBe(2);
    expect(item.direction).toBe(Direction.BtoA);
  });
});
