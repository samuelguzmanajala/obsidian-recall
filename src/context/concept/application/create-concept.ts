import { Concept } from '../domain/concept';
import { ConceptId } from '../domain/concept-id';
import { Side } from '../domain/side';
import { Directionality } from '../domain/directionality';
import { ConceptRepository } from '../domain/concept-repository';

export interface CreateConceptCommand {
  id: string;
  sideA: string;
  sideB: string;
  directionality: Directionality;
}

export class CreateConcept {
  constructor(private readonly repository: ConceptRepository) {}

  async execute(command: CreateConceptCommand): Promise<void> {
    const concept = Concept.create(
      new ConceptId(command.id),
      new Side(command.sideA),
      new Side(command.sideB),
      command.directionality,
    );
    await this.repository.save(concept);
  }
}
