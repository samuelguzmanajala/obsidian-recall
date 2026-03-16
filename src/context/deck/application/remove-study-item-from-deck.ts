import { DeckId } from '../domain/deck-id';
import { DeckRepository } from '../domain/deck-repository';
import { StudyItemId } from '@context/study/domain/study-item-id';

export interface RemoveStudyItemFromDeckCommand {
  deckId: string;
  studyItemId: string;
}

export class RemoveStudyItemFromDeck {
  constructor(private readonly repository: DeckRepository) {}

  async execute(command: RemoveStudyItemFromDeckCommand): Promise<void> {
    const deck = await this.repository.findById(new DeckId(command.deckId));
    if (!deck) return; // Deck already gone — nothing to clean up
    deck.removeStudyItem(new StudyItemId(command.studyItemId));
    await this.repository.save(deck);
  }
}
