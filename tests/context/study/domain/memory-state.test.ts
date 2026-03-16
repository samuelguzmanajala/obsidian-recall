import { describe, it, expect } from 'vitest';
import { MemoryState } from '@context/study/domain/memory-state';

describe('MemoryState', () => {
  it('should create an initial state', () => {
    const state = MemoryState.initial();

    expect(state.stability).toBe(0);
    expect(state.difficulty).toBe(0);
    expect(state.reps).toBe(0);
    expect(state.lapses).toBe(0);
    expect(state.lastReview).toBeNull();
  });

  it('should be due when due date is in the past', () => {
    const pastDate = new Date(Date.now() - 1000 * 60 * 60);
    const state = new MemoryState(1, 5, pastDate, 1, 0, new Date());

    expect(state.isDue).toBe(true);
  });

  it('should not be due when due date is in the future', () => {
    const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24);
    const state = new MemoryState(1, 5, futureDate, 1, 0, new Date());

    expect(state.isDue).toBe(false);
  });

  it('should be equal when all fields match', () => {
    const date = new Date('2026-03-16');
    const a = new MemoryState(1.5, 5.2, date, 3, 1, null);
    const b = new MemoryState(1.5, 5.2, date, 3, 1, null);

    expect(a.equals(b)).toBe(true);
  });

  it('should not be equal when fields differ', () => {
    const date = new Date('2026-03-16');
    const a = new MemoryState(1.5, 5.2, date, 3, 1, null);
    const b = new MemoryState(2.0, 5.2, date, 3, 1, null);

    expect(a.equals(b)).toBe(false);
  });
});
