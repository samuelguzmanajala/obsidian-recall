import { DeckId } from '../domain/deck-id';
import { DeckRepository } from '../domain/deck-repository';
import { StudyItemId } from '@context/study/domain/study-item-id';

export interface AddStudyItemToDeckCommand {
  deckId: string;
  studyItemId: string;
}

export class AddStudyItemToDeck {
  constructor(private readonly repository: DeckRepository) {}

  async execute(command: AddStudyItemToDeckCommand): Promise<void> {
    const deck = await this.repository.findById(new DeckId(command.deckId));
    if (!deck) {
      throw new Error(`Deck not found: ${command.deckId}`);
    }
    deck.addStudyItem(new StudyItemId(command.studyItemId));
    await this.repository.save(deck);
  }
}
