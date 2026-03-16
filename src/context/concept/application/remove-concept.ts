import { ConceptId } from '../domain/concept-id';
import { ConceptRepository } from '../domain/concept-repository';

export interface RemoveConceptCommand {
  id: string;
}

export class RemoveConcept {
  constructor(private readonly repository: ConceptRepository) {}

  async execute(command: RemoveConceptCommand): Promise<void> {
    await this.repository.remove(new ConceptId(command.id));
  }
}
