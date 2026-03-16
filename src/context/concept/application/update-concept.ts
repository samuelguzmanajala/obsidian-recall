import { ConceptId } from '../domain/concept-id';
import { Side } from '../domain/side';
import { Directionality } from '../domain/directionality';
import { ConceptRepository } from '../domain/concept-repository';

export interface UpdateConceptCommand {
  id: string;
  sideA: string;
  sideB: string;
  directionality: Directionality;
}

export class UpdateConcept {
  constructor(private readonly repository: ConceptRepository) {}

  async execute(command: UpdateConceptCommand): Promise<void> {
    const concept = await this.repository.findById(new ConceptId(command.id));
    if (!concept) {
      throw new Error(`Concept not found: ${command.id}`);
    }
    concept.updateSides(new Side(command.sideA), new Side(command.sideB));
    concept.changeDirectionality(command.directionality);
    await this.repository.save(concept);
  }
}
