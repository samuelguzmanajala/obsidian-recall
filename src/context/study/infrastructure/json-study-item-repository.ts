import { StudyItem } from '../domain/study-item';
import { StudyItemId } from '../domain/study-item-id';
import { StudyItemRepository } from '../domain/study-item-repository';
import { MemoryState } from '../domain/memory-state';
import { Direction } from '../domain/direction';
import { ConceptId } from '@context/concept/domain/concept-id';
import { JsonFilePort, SerializedStudyItem } from '@context/shared/infrastructure/json-storage';

type StudyItemStore = Record<string, SerializedStudyItem>;

export class JsonStudyItemRepository implements StudyItemRepository {
  constructor(private readonly file: JsonFilePort) {}

  async save(studyItem: StudyItem): Promise<void> {
    const store = await this.load();
    store[studyItem.id.value] = this.serialize(studyItem);
    await this.file.write(store);
  }

  async findById(id: StudyItemId): Promise<StudyItem | null> {
    const store = await this.load();
    const raw = store[id.value];
    if (!raw) return null;
    return this.deserialize(raw);
  }

  async findByConceptId(conceptId: ConceptId): Promise<StudyItem[]> {
    const store = await this.load();
    return Object.values(store)
      .filter(raw => raw.conceptId === conceptId.value)
      .map(raw => this.deserialize(raw));
  }

  async findAll(): Promise<StudyItem[]> {
    const store = await this.load();
    return Object.values(store).map(raw => this.deserialize(raw));
  }

  async findDue(now: Date): Promise<StudyItem[]> {
    const store = await this.load();
    return Object.values(store)
      .filter(raw => new Date(raw.memoryState.due) <= now)
      .map(raw => this.deserialize(raw));
  }

  async remove(id: StudyItemId): Promise<void> {
    const store = await this.load();
    delete store[id.value];
    await this.file.write(store);
  }

  private async load(): Promise<StudyItemStore> {
    return (await this.file.read<StudyItemStore>()) ?? {};
  }

  private serialize(item: StudyItem): SerializedStudyItem {
    return {
      id: item.id.value,
      conceptId: item.conceptId.value,
      direction: item.direction,
      memoryState: {
        stability: item.memoryState.stability,
        difficulty: item.memoryState.difficulty,
        due: item.memoryState.due.toISOString(),
        reps: item.memoryState.reps,
        lapses: item.memoryState.lapses,
        lastReview: item.memoryState.lastReview?.toISOString() ?? null,
      },
    };
  }

  private deserialize(raw: SerializedStudyItem): StudyItem {
    return StudyItem.reconstitute(
      new StudyItemId(raw.id),
      new ConceptId(raw.conceptId),
      raw.direction as Direction,
      new MemoryState(
        raw.memoryState.stability,
        raw.memoryState.difficulty,
        new Date(raw.memoryState.due),
        raw.memoryState.reps,
        raw.memoryState.lapses,
        raw.memoryState.lastReview ? new Date(raw.memoryState.lastReview) : null,
      ),
    );
  }
}
