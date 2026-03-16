import { StudyItem } from './study-item';
import { StudyItemId } from './study-item-id';
import { ConceptId } from '@context/concept/domain/concept-id';

export interface StudyItemRepository {
  save(studyItem: StudyItem): Promise<void>;
  findById(id: StudyItemId): Promise<StudyItem | null>;
  findByConceptId(conceptId: ConceptId): Promise<StudyItem[]>;
  findAll(): Promise<StudyItem[]>;
  findDue(now: Date): Promise<StudyItem[]>;
  remove(id: StudyItemId): Promise<void>;
}
