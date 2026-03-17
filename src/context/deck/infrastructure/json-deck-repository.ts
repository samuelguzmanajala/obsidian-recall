import { Deck } from '../domain/deck';
import { DeckId } from '../domain/deck-id';
import { DeckRepository } from '../domain/deck-repository';
import { StudyItemId } from '@context/study/domain/study-item-id';
import { JsonFileStorage, SerializedDeck } from '@context/shared/infrastructure/json-storage';

type DeckStore = Record<string, SerializedDeck>;

export class JsonDeckRepository implements DeckRepository {
  constructor(private readonly file: JsonFileStorage) {}

  async save(deck: Deck): Promise<void> {
    const store = await this.load();
    store[deck.id.value] = this.serialize(deck);
    await this.file.write(store);
  }

  async findById(id: DeckId): Promise<Deck | null> {
    const store = await this.load();
    const raw = store[id.value];
    if (!raw) return null;
    return this.deserialize(raw);
  }

  async findByParentId(parentId: DeckId): Promise<Deck[]> {
    const store = await this.load();
    return Object.values(store)
      .filter(raw => raw.parentId === parentId.value)
      .map(raw => this.deserialize(raw));
  }

  async findRoots(): Promise<Deck[]> {
    const store = await this.load();
    return Object.values(store)
      .filter(raw => raw.parentId === null)
      .map(raw => this.deserialize(raw));
  }

  async findAll(): Promise<Deck[]> {
    const store = await this.load();
    return Object.values(store).map(raw => this.deserialize(raw));
  }

  async remove(id: DeckId): Promise<void> {
    const store = await this.load();
    delete store[id.value];
    await this.file.write(store);
  }

  private async load(): Promise<DeckStore> {
    return (await this.file.read<DeckStore>()) ?? {};
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
