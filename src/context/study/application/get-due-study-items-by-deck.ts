import { StudyItemRepository } from '../domain/study-item-repository';
import { ConceptRepository } from '@context/concept/domain/concept-repository';
import { DeckRepository } from '@context/deck/domain/deck-repository';
import { DeckId } from '@context/deck/domain/deck-id';
import { Direction } from '../domain/direction';

export interface DueStudyItemView {
  studyItemId: string;
  conceptId: string;
  sideA: string;
  sideB: string;
  direction: Direction;
  due: Date;
  reps: number;
  lapses: number;
}

export class GetDueStudyItemsByDeck {
  constructor(
    private readonly studyItemRepository: StudyItemRepository,
    private readonly conceptRepository: ConceptRepository,
    private readonly deckRepository: DeckRepository,
  ) {}

  /**
   * Gets due study items for a deck and all its descendants.
   */
  async execute(deckId: string, now: Date = new Date()): Promise<DueStudyItemView[]> {
    const allDueItems = await this.studyItemRepository.findDue(now);
    const allowedIds = await this.collectStudyItemIds(new DeckId(deckId));

    const filteredItems = allDueItems.filter(item => allowedIds.has(item.id.value));
    const views: DueStudyItemView[] = [];

    for (const item of filteredItems) {
      const concept = await this.conceptRepository.findById(item.conceptId);
      if (!concept) continue;

      views.push({
        studyItemId: item.id.value,
        conceptId: item.conceptId.value,
        sideA: concept.sideA.content,
        sideB: concept.sideB.content,
        direction: item.direction,
        due: item.memoryState.due,
        reps: item.memoryState.reps,
        lapses: item.memoryState.lapses,
      });
    }

    return views;
  }

  /**
   * Collects study item IDs from a deck and all descendant decks recursively.
   */
  private async collectStudyItemIds(deckId: DeckId): Promise<Set<string>> {
    const ids = new Set<string>();

    const deck = await this.deckRepository.findById(deckId);
    if (!deck) return ids;

    for (const si of deck.studyItemIds) {
      ids.add(si.value);
    }

    // Recurse into child decks
    const children = await this.deckRepository.findByParentId(deckId);
    for (const child of children) {
      const childIds = await this.collectStudyItemIds(child.id);
      for (const id of childIds) {
        ids.add(id);
      }
    }

    return ids;
  }
}
