import { describe, it, expect, vi } from 'vitest';
import { CreateStudyItem } from '@context/study/application/create-study-item';
import { StudyItemRepository } from '@context/study/domain/study-item-repository';
import { Direction } from '@context/study/domain/direction';

describe('CreateStudyItem', () => {
  const mockRepository: StudyItemRepository = {
    save: vi.fn(),
    findById: vi.fn(),
    findByConceptId: vi.fn(),
    findAll: vi.fn(),
    findDue: vi.fn(),
    remove: vi.fn(),
  };

  it('should create and save a study item', async () => {
    const useCase = new CreateStudyItem(mockRepository);

    await useCase.execute({
      id: crypto.randomUUID(),
      conceptId: crypto.randomUUID(),
      direction: Direction.AtoB,
    });

    expect(mockRepository.save).toHaveBeenCalledOnce();
  });
});
