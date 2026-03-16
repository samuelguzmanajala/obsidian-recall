import { StudyItem } from '../domain/study-item';
import { StudyItemId } from '../domain/study-item-id';
import { StudyItemRepository } from '../domain/study-item-repository';
import { ConceptId } from '@context/concept/domain/concept-id';
import { Direction } from '../domain/direction';

export interface CreateStudyItemCommand {
  id: string;
  conceptId: string;
  direction: Direction;
}

export class CreateStudyItem {
  constructor(private readonly repository: StudyItemRepository) {}

  async execute(command: CreateStudyItemCommand): Promise<void> {
    const studyItem = StudyItem.create(
      new StudyItemId(command.id),
      new ConceptId(command.conceptId),
      command.direction,
    );
    await this.repository.save(studyItem);
  }
}
