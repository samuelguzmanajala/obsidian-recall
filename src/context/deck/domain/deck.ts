import { DeckId } from './deck-id';
import { StudyItemId } from '@context/study/domain/study-item-id';

export class Deck {
  private constructor(
    readonly id: DeckId,
    private _name: string,
    private _parentId: DeckId | null,
    private _studyItemIds: Set<string>,
  ) {}

  static create(id: DeckId, name: string, parentId: DeckId | null = null): Deck {
    if (!name || name.trim().length === 0) {
      throw new Error('Deck name cannot be empty');
    }
    return new Deck(id, name, parentId, new Set());
  }

  static reconstitute(
    id: DeckId,
    name: string,
    parentId: DeckId | null,
    studyItemIds: StudyItemId[],
  ): Deck {
    return new Deck(id, name, parentId, new Set(studyItemIds.map(si => si.value)));
  }

  get name(): string {
    return this._name;
  }

  get parentId(): DeckId | null {
    return this._parentId;
  }

  get studyItemIds(): StudyItemId[] {
    return Array.from(this._studyItemIds).map(id => new StudyItemId(id));
  }

  get isRoot(): boolean {
    return this._parentId === null;
  }

  rename(name: string): void {
    if (!name || name.trim().length === 0) {
      throw new Error('Deck name cannot be empty');
    }
    this._name = name;
  }

  nest(parentId: DeckId): void {
    if (parentId.equals(this.id)) {
      throw new Error('A deck cannot be its own parent');
    }
    this._parentId = parentId;
  }

  unparent(): void {
    this._parentId = null;
  }

  addStudyItem(studyItemId: StudyItemId): void {
    this._studyItemIds.add(studyItemId.value);
  }

  removeStudyItem(studyItemId: StudyItemId): void {
    this._studyItemIds.delete(studyItemId.value);
  }

  hasStudyItem(studyItemId: StudyItemId): boolean {
    return this._studyItemIds.has(studyItemId.value);
  }
}
