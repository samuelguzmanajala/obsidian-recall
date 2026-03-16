import { Deck } from '../domain/deck';
import { DeckId } from '../domain/deck-id';
import { DeckRepository } from '../domain/deck-repository';

export interface CreateDeckCommand {
  id: string;
  name: string;
  parentId: string | null;
}

export class CreateDeck {
  constructor(private readonly repository: DeckRepository) {}

  async execute(command: CreateDeckCommand): Promise<void> {
    const parentId = command.parentId ? new DeckId(command.parentId) : null;
    const deck = Deck.create(new DeckId(command.id), command.name, parentId);
    await this.repository.save(deck);
  }
}
