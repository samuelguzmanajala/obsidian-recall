import { StudyItemRepository } from '../domain/study-item-repository';
import { ConceptRepository } from '@context/concept/domain/concept-repository';
import { ConceptId } from '@context/concept/domain/concept-id';
import { Direction } from '../domain/direction';

export interface DueStudyItemView {
  studyItemId: string;
  conceptId: string;
  sideA: string;
  sideB: string;
  direction: Direction;
  due: Date;
  reps: number;
  lapses: number;
}

export class GetDueStudyItems {
  constructor(
    private readonly studyItemRepository: StudyItemRepository,
    private readonly conceptRepository: ConceptRepository,
  ) {}

  async execute(now: Date = new Date()): Promise<DueStudyItemView[]> {
    const dueItems = await this.studyItemRepository.findDue(now);
    const views: DueStudyItemView[] = [];

    for (const item of dueItems) {
      const concept = await this.conceptRepository.findById(item.conceptId);
      if (!concept) continue;

      views.push({
        studyItemId: item.id.value,
        conceptId: item.conceptId.value,
        sideA: concept.sideA.content,
        sideB: concept.sideB.content,
        direction: item.direction,
        due: item.memoryState.due,
        reps: item.memoryState.reps,
        lapses: item.memoryState.lapses,
      });
    }

    return views;
  }
}
