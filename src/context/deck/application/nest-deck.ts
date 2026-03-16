import { DeckId } from '../domain/deck-id';
import { DeckRepository } from '../domain/deck-repository';

export interface NestDeckCommand {
  deckId: string;
  parentId: string;
}

export class NestDeck {
  constructor(private readonly repository: DeckRepository) {}

  async execute(command: NestDeckCommand): Promise<void> {
    const deck = await this.repository.findById(new DeckId(command.deckId));
    if (!deck) {
      throw new Error(`Deck not found: ${command.deckId}`);
    }
    deck.nest(new DeckId(command.parentId));
    await this.repository.save(deck);
  }
}
