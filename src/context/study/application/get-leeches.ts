import { StudyItemRepository } from '../domain/study-item-repository';
import { ConceptRepository } from '@context/concept/domain/concept-repository';
import { Direction } from '../domain/direction';

export interface LeechView {
  studyItemId: string;
  conceptId: string;
  sideA: string;
  sideB: string;
  direction: Direction;
  lapses: number;
  reps: number;
}

export class GetLeeches {
  constructor(
    private readonly studyItemRepository: StudyItemRepository,
    private readonly conceptRepository: ConceptRepository,
  ) {}

  async execute(threshold: number): Promise<LeechView[]> {
    const allItems = await this.studyItemRepository.findAll();
    const leeches = allItems.filter(item => item.memoryState.lapses >= threshold);

    // Sort by lapses descending — worst first
    leeches.sort((a, b) => b.memoryState.lapses - a.memoryState.lapses);

    const views: LeechView[] = [];

    for (const item of leeches) {
      const concept = await this.conceptRepository.findById(item.conceptId);
      if (!concept) continue;

      views.push({
        studyItemId: item.id.value,
        conceptId: item.conceptId.value,
        sideA: concept.sideA.content,
        sideB: concept.sideB.content,
        direction: item.direction,
        lapses: item.memoryState.lapses,
        reps: item.memoryState.reps,
      });
    }

    return views;
  }
}
