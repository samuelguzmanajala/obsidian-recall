import { describe, it, expect, vi } from 'vitest';
import { ReviewStudyItem, ReviewStudyItemCommand } from '@context/study/application/review-study-item';
import { StudyItemRepository } from '@context/study/domain/study-item-repository';
import { ReviewLog } from '@context/study/domain/review-log';
import { Scheduler } from '@context/study/domain/scheduler';
import { StudyItem } from '@context/study/domain/study-item';
import { StudyItemId } from '@context/study/domain/study-item-id';
import { ConceptId } from '@context/concept/domain/concept-id';
import { Direction } from '@context/study/domain/direction';
import { Rating } from '@context/study/domain/rating';
import { MemoryState } from '@context/study/domain/memory-state';

describe('ReviewStudyItem', () => {
  const studyItemId = crypto.randomUUID();
  const studyItem = StudyItem.create(
    new StudyItemId(studyItemId),
    new ConceptId(crypto.randomUUID()),
    Direction.AtoB,
  );

  const mockScheduler: Scheduler = {
    schedule(currentState: MemoryState, _rating: Rating, now: Date): MemoryState {
      return new MemoryState(
        currentState.stability + 1,
        currentState.difficulty,
        new Date(now.getTime() + 1000 * 60 * 60 * 24),
        currentState.reps + 1,
        currentState.lapses,
        now,
      );
    },
  };

  it('should review a study item and log the review', async () => {
    const mockRepository: StudyItemRepository = {
      save: vi.fn(),
      findById: vi.fn().mockResolvedValue(studyItem),
      findByConceptId: vi.fn(),
      findDue: vi.fn(),
      remove: vi.fn(),
    };
    const mockReviewLog: ReviewLog = {
      append: vi.fn(),
      findByStudyItemId: vi.fn(),
      findAll: vi.fn(),
      findSince: vi.fn(),
    };

    const useCase = new ReviewStudyItem(mockRepository, mockScheduler, mockReviewLog);

    await useCase.execute({ studyItemId, rating: Rating.Good });

    expect(mockRepository.save).toHaveBeenCalledOnce();
    expect(mockReviewLog.append).toHaveBeenCalledOnce();
    expect(studyItem.memoryState.reps).toBe(1);
  });

  it('should throw if study item not found', async () => {
    const mockRepository: StudyItemRepository = {
      save: vi.fn(),
      findById: vi.fn().mockResolvedValue(null),
      findByConceptId: vi.fn(),
      findDue: vi.fn(),
      remove: vi.fn(),
    };
    const mockReviewLog: ReviewLog = {
      append: vi.fn(),
      findByStudyItemId: vi.fn(),
      findAll: vi.fn(),
      findSince: vi.fn(),
    };

    const useCase = new ReviewStudyItem(mockRepository, mockScheduler, mockReviewLog);

    await expect(useCase.execute({
      studyItemId: 'non-existent',
      rating: Rating.Good,
    })).rejects.toThrow('StudyItem not found: non-existent');
  });
});
