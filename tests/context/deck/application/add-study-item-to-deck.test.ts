import { describe, it, expect, vi } from 'vitest';
import { AddStudyItemToDeck } from '@context/deck/application/add-study-item-to-deck';
import { DeckRepository } from '@context/deck/domain/deck-repository';
import { Deck } from '@context/deck/domain/deck';
import { DeckId } from '@context/deck/domain/deck-id';
import { StudyItemId } from '@context/study/domain/study-item-id';

describe('AddStudyItemToDeck', () => {
  const deckId = crypto.randomUUID();
  const studyItemId = crypto.randomUUID();

  it('should add a study item to a deck', async () => {
    const deck = Deck.create(new DeckId(deckId), 'Alemán');
    const mockRepository: DeckRepository = {
      save: vi.fn(),
      findById: vi.fn().mockResolvedValue(deck),
      findByParentId: vi.fn(),
      findRoots: vi.fn(),
      findAll: vi.fn(),
      remove: vi.fn(),
    };
    const useCase = new AddStudyItemToDeck(mockRepository);

    await useCase.execute({ deckId, studyItemId });

    expect(deck.hasStudyItem(new StudyItemId(studyItemId))).toBe(true);
    expect(mockRepository.save).toHaveBeenCalledOnce();
  });

  it('should throw if deck not found', async () => {
    const mockRepository: DeckRepository = {
      save: vi.fn(),
      findById: vi.fn().mockResolvedValue(null),
      findByParentId: vi.fn(),
      findRoots: vi.fn(),
      findAll: vi.fn(),
      remove: vi.fn(),
    };
    const useCase = new AddStudyItemToDeck(mockRepository);

    await expect(useCase.execute({ deckId: 'non-existent', studyItemId }))
      .rejects.toThrow('Deck not found: non-existent');
  });
});
