import { describe, it, expect, vi } from 'vitest';
import { UpdateConcept, UpdateConceptCommand } from '@context/concept/application/update-concept';
import { ConceptRepository } from '@context/concept/domain/concept-repository';
import { Concept } from '@context/concept/domain/concept';
import { ConceptId } from '@context/concept/domain/concept-id';
import { Side } from '@context/concept/domain/side';
import { Directionality } from '@context/concept/domain/directionality';

describe('UpdateConcept', () => {
  const conceptId = crypto.randomUUID();
  const existingConcept = Concept.create(
    new ConceptId(conceptId),
    new Side('Old question'),
    new Side('Old answer'),
    Directionality.Unidirectional,
  );

  it('should update an existing concept', async () => {
    const mockRepository: ConceptRepository = {
      save: vi.fn(),
      findById: vi.fn().mockResolvedValue(existingConcept),
      findAll: vi.fn(),
      remove: vi.fn(),
    };
    const useCase = new UpdateConcept(mockRepository);

    await useCase.execute({
      id: conceptId,
      sideA: 'New question',
      sideB: 'New answer',
      directionality: Directionality.Bidirectional,
    });

    expect(mockRepository.save).toHaveBeenCalledOnce();
    expect(existingConcept.sideA.content).toBe('New question');
    expect(existingConcept.sideB.content).toBe('New answer');
    expect(existingConcept.isBidirectional).toBe(true);
  });

  it('should throw if concept not found', async () => {
    const mockRepository: ConceptRepository = {
      save: vi.fn(),
      findById: vi.fn().mockResolvedValue(null),
      findAll: vi.fn(),
      remove: vi.fn(),
    };
    const useCase = new UpdateConcept(mockRepository);

    await expect(useCase.execute({
      id: 'non-existent',
      sideA: 'A',
      sideB: 'B',
      directionality: Directionality.Unidirectional,
    })).rejects.toThrow('Concept not found: non-existent');
  });
});
