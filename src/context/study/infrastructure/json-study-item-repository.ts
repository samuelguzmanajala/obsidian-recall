import { StudyItem } from '../domain/study-item';
import { StudyItemId } from '../domain/study-item-id';
import { StudyItemRepository } from '../domain/study-item-repository';
import { MemoryState } from '../domain/memory-state';
import { Direction } from '../domain/direction';
import { ConceptId } from '@context/concept/domain/concept-id';
import { JsonStoragePort, StorageData, SerializedStudyItem } from '@context/shared/infrastructure/json-storage';

export class JsonStudyItemRepository implements StudyItemRepository {
  private data: StorageData | null = null;

  constructor(private readonly storage: JsonStoragePort) {}

  private async getData(): Promise<StorageData> {
    if (!this.data) {
      this.data = await this.storage.load();
    }
    return this.data;
  }

  async save(studyItem: StudyItem): Promise<void> {
    const data = await this.getData();
    data.studyItems[studyItem.id.value] = this.serialize(studyItem);
    await this.storage.save(data);
  }

  async findById(id: StudyItemId): Promise<StudyItem | null> {
    const data = await this.getData();
    const raw = data.studyItems[id.value];
    if (!raw) return null;
    return this.deserialize(raw);
  }

  async findByConceptId(conceptId: ConceptId): Promise<StudyItem[]> {
    const data = await this.getData();
    return Object.values(data.studyItems)
      .filter(raw => raw.conceptId === conceptId.value)
      .map(raw => this.deserialize(raw));
  }

  async findDue(now: Date): Promise<StudyItem[]> {
    const data = await this.getData();
    return Object.values(data.studyItems)
      .filter(raw => new Date(raw.memoryState.due) <= now)
      .map(raw => this.deserialize(raw));
  }

  async remove(id: StudyItemId): Promise<void> {
    const data = await this.getData();
    delete data.studyItems[id.value];
    await this.storage.save(data);
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
