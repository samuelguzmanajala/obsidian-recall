import { Concept } from '../domain/concept';
import { ConceptId } from '../domain/concept-id';
import { Side } from '../domain/side';
import { Directionality } from '../domain/directionality';
import { ConceptRepository } from '../domain/concept-repository';
import { JsonFilePort, SerializedConcept } from '@context/shared/infrastructure/json-storage';

type ConceptStore = Record<string, SerializedConcept>;

export class JsonConceptRepository implements ConceptRepository {
  private cache: ConceptStore | null = null;

  constructor(private readonly file: JsonFilePort) {}

  private async load(): Promise<ConceptStore> {
    if (!this.cache) {
      this.cache = (await this.file.read<ConceptStore>()) ?? {};
    }
    return this.cache;
  }

  private async persist(): Promise<void> {
    if (this.cache) {
      await this.file.write(this.cache);
    }
  }

  async save(concept: Concept): Promise<void> {
    const store = await this.load();
    store[concept.id.value] = this.serialize(concept);
    await this.persist();
  }

  async findById(id: ConceptId): Promise<Concept | null> {
    const store = await this.load();
    const raw = store[id.value];
    if (!raw) return null;
    return this.deserialize(raw);
  }

  async findAll(): Promise<Concept[]> {
    const store = await this.load();
    return Object.values(store).map(raw => this.deserialize(raw));
  }

  async remove(id: ConceptId): Promise<void> {
    const store = await this.load();
    delete store[id.value];
    await this.persist();
  }

  private serialize(concept: Concept): SerializedConcept {
    return {
      id: concept.id.value,
      sideA: concept.sideA.content,
      sideB: concept.sideB.content,
      directionality: concept.directionality,
    };
  }

  private deserialize(raw: SerializedConcept): Concept {
    return Concept.create(
      new ConceptId(raw.id),
      new Side(raw.sideA),
      new Side(raw.sideB),
      raw.directionality as Directionality,
    );
  }
}
