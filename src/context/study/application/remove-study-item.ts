import { StudyItemId } from '../domain/study-item-id';
import { StudyItemRepository } from '../domain/study-item-repository';

export interface RemoveStudyItemCommand {
  id: string;
}

export class RemoveStudyItem {
  constructor(private readonly repository: StudyItemRepository) {}

  async execute(command: RemoveStudyItemCommand): Promise<void> {
    await this.repository.remove(new StudyItemId(command.id));
  }
}
