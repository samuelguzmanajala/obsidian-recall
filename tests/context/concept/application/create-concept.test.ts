import { describe, it, expect, vi } from 'vitest';
import { CreateConcept, CreateConceptCommand } from '@context/concept/application/create-concept';
import { ConceptRepository } from '@context/concept/domain/concept-repository';
import { Directionality } from '@context/concept/domain/directionality';

describe('CreateConcept', () => {
  const mockRepository: ConceptRepository = {
    save: vi.fn(),
    findById: vi.fn(),
    findAll: vi.fn(),
    remove: vi.fn(),
  };

  it('should create and save a concept', async () => {
    const useCase = new CreateConcept(mockRepository);
    const command: CreateConceptCommand = {
      id: crypto.randomUUID(),
      sideA: 'What is DDD?',
      sideB: 'Domain-Driven Design',
      directionality: Directionality.Unidirectional,
    };

    await useCase.execute(command);

    expect(mockRepository.save).toHaveBeenCalledOnce();
  });

  it('should reject empty sides', async () => {
    const useCase = new CreateConcept(mockRepository);
    const command: CreateConceptCommand = {
      id: crypto.randomUUID(),
      sideA: '',
      sideB: 'Something',
      directionality: Directionality.Unidirectional,
    };

    await expect(useCase.execute(command)).rejects.toThrow('Side content cannot be empty');
  });
});
