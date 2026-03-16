import { Deck } from '../domain/deck';
import { DeckId } from '../domain/deck-id';
import { DeckRepository } from '../domain/deck-repository';
import { StudyItemId } from '@context/study/domain/study-item-id';
import { JsonStoragePort, StorageData, SerializedDeck } from '@context/shared/infrastructure/json-storage';

export class JsonDeckRepository implements DeckRepository {
  private data: StorageData | null = null;

  constructor(private readonly storage: JsonStoragePort) {}

  private async getData(): Promise<StorageData> {
    if (!this.data) {
      this.data = await this.storage.load();
    }
    return this.data;
  }

  async save(deck: Deck): Promise<void> {
    const data = await this.getData();
    data.decks[deck.id.value] = this.serialize(deck);
    await this.storage.save(data);
  }

  async findById(id: DeckId): Promise<Deck | null> {
    const data = await this.getData();
    const raw = data.decks[id.value];
    if (!raw) return null;
    return this.deserialize(raw);
  }

  async findByParentId(parentId: DeckId): Promise<Deck[]> {
    const data = await this.getData();
    return Object.values(data.decks)
      .filter(raw => raw.parentId === parentId.value)
      .map(raw => this.deserialize(raw));
  }

  async findRoots(): Promise<Deck[]> {
    const data = await this.getData();
    return Object.values(data.decks)
      .filter(raw => raw.parentId === null)
      .map(raw => this.deserialize(raw));
  }

  async findAll(): Promise<Deck[]> {
    const data = await this.getData();
    return Object.values(data.decks).map(raw => this.deserialize(raw));
  }

  async remove(id: DeckId): Promise<void> {
    const data = await this.getData();
    delete data.decks[id.value];
    await this.storage.save(data);
  }

  private serialize(deck: Deck): SerializedDeck {
    return {
      id: deck.id.value,
      name: deck.name,
      parentId: deck.parentId?.value ?? null,
      studyItemIds: deck.studyItemIds.map(si => si.value),
    };
  }

  private deserialize(raw: SerializedDeck): Deck {
    return Deck.reconstitute(
      new DeckId(raw.id),
      raw.name,
      raw.parentId ? new DeckId(raw.parentId) : null,
      raw.studyItemIds.map(id => new StudyItemId(id)),
    );
  }
}
