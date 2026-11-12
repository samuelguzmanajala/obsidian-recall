// In-memory doubles of the storage ports. Maps iterate like the server's tables: a re-saved key keeps
// its position, a removed and re-added key goes last. tests/server/persistence/contract.test.ts runs
// the same behaviour tests against these and the SQLite adapters.
import type { ConceptRepository } from '@context/concept/domain/concept-repository';
import { Concept } from '@context/concept/domain/concept';
import type { ConceptId } from '@context/concept/domain/concept-id';
import { foldText, sidesContain } from '@context/concept/domain/text-match';
import type { StudyItemRepository } from '@context/study/domain/study-item-repository';
import { StudyItem } from '@context/study/domain/study-item';
import type { StudyItemId } from '@context/study/domain/study-item-id';
import type { DeckRepository } from '@context/deck/domain/deck-repository';
import { Deck } from '@context/deck/domain/deck';
import type { DeckId } from '@context/deck/domain/deck-id';
import type { ReviewLog } from '@context/study/domain/review-log';
import type { Review } from '@context/study/domain/review';
import type { CardAlias, FileIndex, SerializedSyncState, SourceIndex, SourceLocation } from '@context/indexing/domain/source-index';

const copyConcept = (c: Concept) => Concept.create(c.id, c.sideA, c.sideB, c.directionality);
const copyItem = (i: StudyItem) => StudyItem.reconstitute(i.id, i.conceptId, i.direction, i.memoryState);
const copyDeck = (d: Deck) => Deck.reconstitute(d.id, d.name, d.parentId, d.studyItemIds);

export class InMemoryConceptRepository implements ConceptRepository {
  readonly rows = new Map<string, Concept>();
  async save(concept: Concept) { this.rows.set(concept.id.value, copyConcept(concept)); }
  async findById(id: ConceptId) { const c = this.rows.get(id.value); return c ? copyConcept(c) : null; }
  async findAll() { return [...this.rows.values()].map(copyConcept); }
  async findContaining(text: string) {
    const folded = foldText(text);
    return (await this.findAll()).filter(c => sidesContain(c.sideA.content, c.sideB.content, folded));
  }
  async remove(id: ConceptId) { this.rows.delete(id.value); }
}

export class InMemoryStudyItemRepository implements StudyItemRepository {
  readonly rows = new Map<string, StudyItem>();
  async save(item: StudyItem) { this.rows.set(item.id.value, copyItem(item)); }
  async findById(id: StudyItemId) { const i = this.rows.get(id.value); return i ? copyItem(i) : null; }
  async findByConceptId(conceptId: ConceptId) { return (await this.findAll()).filter(i => i.conceptId.equals(conceptId)); }
  async findAll() { return [...this.rows.values()].map(copyItem); }
  async findDue(now: Date) { return (await this.findAll()).filter(i => i.memoryState.due <= now); }
  async remove(id: StudyItemId) { this.rows.delete(id.value); }
}

export class InMemoryDeckRepository implements DeckRepository {
  readonly rows = new Map<string, Deck>();
  async save(deck: Deck) { this.rows.set(deck.id.value, copyDeck(deck)); }
  async findById(id: DeckId) { const d = this.rows.get(id.value); return d ? copyDeck(d) : null; }
  async findByParentId(parentId: DeckId) { return (await this.findAll()).filter(d => d.parentId?.value === parentId.value); }
  async findRoots() { return (await this.findAll()).filter(d => d.parentId === null); }
  async findAll() { return [...this.rows.values()].map(copyDeck); }
  async remove(id: DeckId) { this.rows.delete(id.value); }
}

export class InMemoryReviewLog implements ReviewLog {
  readonly rows: Review[] = [];
  async append(review: Review) {
    if (!this.rows.some(r => r.studyItemId.equals(review.studyItemId) && r.timestamp.getTime() === review.timestamp.getTime())) this.rows.push(review);
  }
  async findAll() { return [...this.rows].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()); }
  async findByStudyItemId(id: StudyItemId) { return (await this.findAll()).filter(r => r.studyItemId.equals(id)); }
  async findSince(since: Date) { return (await this.findAll()).filter(r => r.timestamp >= since); }
  async countSince(since: Date) { return (await this.findSince(since)).length; }
  async countFirstReviewedSince(since: Date) {
    const first = new Map<string, number>();
    for (const r of await this.findAll()) if (!first.has(r.studyItemId.value)) first.set(r.studyItemId.value, r.timestamp.getTime());
    return [...first.values()].filter(t => t >= since.getTime()).length;
  }
}

const copyIndex = (i: FileIndex): FileIndex => ({ cardKeys: new Map(i.cardKeys), conceptLines: new Map(i.conceptLines), studyItemIds: [...i.studyItemIds], deckIds: [...i.deckIds] });

export class InMemorySourceIndex implements SourceIndex {
  readonly files = new Map<string, FileIndex>();
  readonly tags = new Map<string, string>();
  readonly aliases = new Map<string, CardAlias>();
  async get(path: string) { const i = this.files.get(path); return i ? copyIndex(i) : null; }
  async put(path: string, index: FileIndex) { this.files.set(path, copyIndex(index)); }
  async remove(path: string) { this.files.delete(path); }
  async rename(oldPath: string, newPath: string) {
    const index = this.files.get(oldPath);
    if (!index) return;
    this.files.delete(oldPath);
    this.files.set(newPath, index);
  }
  async otherFilesWithConcept(conceptId: string, excludingPath: string) {
    return [...this.files].filter(([path, i]) => path !== excludingPath && [...i.cardKeys.values()].includes(conceptId))
      .map(([path, i]) => ({ path, deckIds: [...i.deckIds] }));
  }
  async locate(conceptId: string): Promise<SourceLocation | null> {
    for (const [filePath, i] of this.files) if ([...i.cardKeys.values()].includes(conceptId)) return { filePath, line: i.conceptLines.get(conceptId) ?? 1 };
    return null;
  }
  async deckForTag(tag: string) { return this.tags.get(tag) ?? null; }
  async setDeckForTag(tag: string, deckId: string) { this.tags.set(tag, deckId); }
  async snapshot(): Promise<SerializedSyncState> {
    const fileIndices: SerializedSyncState['fileIndices'] = {};
    for (const [path, i] of this.files) {
      fileIndices[path] = { cardKeys: Object.fromEntries(i.cardKeys), conceptLines: Object.fromEntries(i.conceptLines), studyItemIds: [...i.studyItemIds], deckIds: [...i.deckIds] };
    }
    return { fileIndices, tagToDeckId: Object.fromEntries(this.tags) };
  }
  async conceptForCard(cardKey: string) {
    for (const i of this.files.values()) { const c = i.cardKeys.get(cardKey); if (c !== undefined) return c; }
    return null;
  }
  async aliasFor(cardKey: string) { const a = this.aliases.get(cardKey); return a ? { ...a } : null; }
  async aliasOwner(id: string) {
    for (const [key, a] of this.aliases) if (a.conceptId === id || a.aToB === id || a.bToA === id) return key;
    return null;
  }
  async setAlias(cardKey: string, alias: CardAlias) {
    for (const [key, a] of this.aliases) if (key === cardKey || a.conceptId === alias.conceptId) this.aliases.delete(key);
    this.aliases.set(cardKey, { ...alias });
  }
}

/** One set of ports, shared by every component built over it (a "database"). */
export interface Stores {
  concepts: ConceptRepository;
  studyItems: StudyItemRepository;
  decks: DeckRepository;
  reviews: ReviewLog;
  sources: SourceIndex;
}

export function inMemoryStores(): Stores {
  return {
    concepts: new InMemoryConceptRepository(), studyItems: new InMemoryStudyItemRepository(),
    decks: new InMemoryDeckRepository(), reviews: new InMemoryReviewLog(), sources: new InMemorySourceIndex(),
  };
}
