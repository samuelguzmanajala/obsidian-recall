import { Concept } from '../domain/concept';
import { ConceptId } from '../domain/concept-id';
import { Side } from '../domain/side';
import { Directionality } from '../domain/directionality';
import { ConceptRepository } from '../domain/concept-repository';
import { JsonStoragePort, StorageData, SerializedConcept } from '@context/shared/infrastructure/json-storage';

export class JsonConceptRepository implements ConceptRepository {
  private data: StorageData | null = null;

  constructor(private readonly storage: JsonStoragePort) {}

  private async getData(): Promise<StorageData> {
    if (!this.data) {
      this.data = await this.storage.load();
    }
    return this.data;
  }

  async save(concept: Concept): Promise<void> {
    const data = await this.getData();
    data.concepts[concept.id.value] = this.serialize(concept);
    await this.storage.save(data);
  }

  async findById(id: ConceptId): Promise<Concept | null> {
    const data = await this.getData();
    const raw = data.concepts[id.value];
    if (!raw) return null;
    return this.deserialize(raw);
  }

  async findAll(): Promise<Concept[]> {
    const data = await this.getData();
    return Object.values(data.concepts).map(raw => this.deserialize(raw));
  }

  async remove(id: ConceptId): Promise<void> {
    const data = await this.getData();
    delete data.concepts[id.value];
    await this.storage.save(data);
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
