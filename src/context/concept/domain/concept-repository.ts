import { Concept } from './concept';
import { ConceptId } from './concept-id';

export interface ConceptRepository {
  save(concept: Concept): Promise<void>;
  findById(id: ConceptId): Promise<Concept | null>;
  findAll(): Promise<Concept[]>;
  /**
   * Concepts with `text` in side A or side B, in storage order. Compared after `foldText` (case,
   * accents and whitespace runs ignored); text that folds to nothing matches nothing.
   */
  findContaining(text: string): Promise<Concept[]>;
  remove(id: ConceptId): Promise<void>;
}
