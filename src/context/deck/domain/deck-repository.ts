import { Deck } from './deck';
import { DeckId } from './deck-id';

export interface DeckRepository {
  save(deck: Deck): Promise<void>;
  findById(id: DeckId): Promise<Deck | null>;
  findByParentId(parentId: DeckId): Promise<Deck[]>;
  findRoots(): Promise<Deck[]>;
  findAll(): Promise<Deck[]>;
  remove(id: DeckId): Promise<void>;
}
