import { DeckId } from '../domain/deck-id';
import { DeckRepository } from '../domain/deck-repository';

export interface RemoveDeckCommand {
  id: string;
}

export class RemoveDeck {
  constructor(private readonly repository: DeckRepository) {}

  async execute(command: RemoveDeckCommand): Promise<void> {
    await this.repository.remove(new DeckId(command.id));
  }
}
