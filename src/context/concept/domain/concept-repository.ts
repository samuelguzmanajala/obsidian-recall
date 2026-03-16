import { Concept } from './concept';
import { ConceptId } from './concept-id';

export interface ConceptRepository {
  save(concept: Concept): Promise<void>;
  findById(id: ConceptId): Promise<Concept | null>;
  findAll(): Promise<Concept[]>;
  remove(id: ConceptId): Promise<void>;
}
