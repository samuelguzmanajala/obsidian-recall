import type { ConceptRepository } from '../../context/concept/domain/concept-repository';
import { Concept } from '../../context/concept/domain/concept';
import { ConceptId } from '../../context/concept/domain/concept-id';
import { Side } from '../../context/concept/domain/side';
import type { Directionality } from '../../context/concept/domain/directionality';
import type { StudyItemRepository } from '../../context/study/domain/study-item-repository';
import { StudyItem } from '../../context/study/domain/study-item';
import { StudyItemId } from '../../context/study/domain/study-item-id';
import { MemoryState } from '../../context/study/domain/memory-state';
import type { Direction } from '../../context/study/domain/direction';
import type { DeckRepository } from '../../context/deck/domain/deck-repository';
import { Deck } from '../../context/deck/domain/deck';
import { DeckId } from '../../context/deck/domain/deck-id';
import type { ReviewLog } from '../../context/study/domain/review-log';
import { Review } from '../../context/study/domain/review';
import type { Rating } from '../../context/study/domain/rating';
import type { RecallDatabase } from '../database';

type Row = Record<string, unknown>;

export class SqliteConceptRepository implements ConceptRepository {
  constructor(private readonly db: RecallDatabase) {}
  async save(concept: Concept): Promise<void> {
    this.db.stmt(`INSERT INTO concepts VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      side_a=excluded.side_a, side_b=excluded.side_b, directionality=excluded.directionality`)
      .run(concept.id.value, concept.sideA.content, concept.sideB.content, concept.directionality);
  }
  async findById(id: ConceptId): Promise<Concept | null> {
    const row = this.db.stmt('SELECT * FROM concepts WHERE id=?').get(id.value);
    return row ? this.concept(row) : null;
  }
  async findAll(): Promise<Concept[]> {
    return this.db.stmt('SELECT * FROM concepts ORDER BY rowid').all().map(r => this.concept(r));
  }
  async remove(id: ConceptId): Promise<void> {
    this.db.stmt('DELETE FROM concepts WHERE id=?').run(id.value);
  }
  private concept(r: Row): Concept {
    return Concept.create(new ConceptId(r.id as string), new Side(r.side_a as string), new Side(r.side_b as string), r.directionality as Directionality);
  }
}

export class SqliteStudyItemRepository implements StudyItemRepository {
  constructor(private readonly db: RecallDatabase) {}
  async save(item: StudyItem): Promise<void> {
    const m = item.memoryState;
    this.db.stmt(`INSERT INTO study_items VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      concept_id=excluded.concept_id, direction=excluded.direction, stability=excluded.stability, difficulty=excluded.difficulty,
      due=excluded.due, reps=excluded.reps, lapses=excluded.lapses, last_review=excluded.last_review`)
      .run(item.id.value, item.conceptId.value, item.direction, m.stability, m.difficulty, m.due.getTime(), m.reps, m.lapses, m.lastReview?.getTime() ?? null);
  }
  async findById(id: StudyItemId): Promise<StudyItem | null> {
    const row = this.db.stmt('SELECT * FROM study_items WHERE id=?').get(id.value);
    return row ? this.item(row) : null;
  }
  async findByConceptId(conceptId: ConceptId): Promise<StudyItem[]> {
    return this.db.stmt('SELECT * FROM study_items WHERE concept_id=? ORDER BY rowid').all(conceptId.value).map(r => this.item(r));
  }
  async findAll(): Promise<StudyItem[]> {
    return this.db.stmt('SELECT * FROM study_items ORDER BY rowid').all().map(r => this.item(r));
  }
  async findDue(now: Date): Promise<StudyItem[]> {
    return this.db.stmt('SELECT * FROM study_items WHERE due<=? ORDER BY rowid').all(now.getTime()).map(r => this.item(r));
  }
  async remove(id: StudyItemId): Promise<void> {
    this.db.stmt('DELETE FROM study_items WHERE id=?').run(id.value);
  }
  private item(r: Row): StudyItem {
    return StudyItem.reconstitute(new StudyItemId(r.id as string), new ConceptId(r.concept_id as string), r.direction as Direction,
      new MemoryState(r.stability as number, r.difficulty as number, new Date(r.due as number), r.reps as number, r.lapses as number,
        r.last_review === null ? null : new Date(r.last_review as number)));
  }
}

export class SqliteDeckRepository implements DeckRepository {
  constructor(private readonly db: RecallDatabase) {}
  /** Writes only membership changes when the new order is "kept items, then added ones" (always, for Deck's Set). */
  async save(deck: Deck): Promise<void> {
    this.db.stmt('INSERT INTO decks VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, parent_id=excluded.parent_id')
      .run(deck.id.value, deck.name, deck.parentId?.value ?? null);
    const before = this.items(deck.id.value);
    const after = deck.studyItemIds.map(id => id.value);
    const wanted = new Set(after), existing = new Set(before);
    const added = after.filter(id => !existing.has(id));
    const incremental = [...before.filter(id => wanted.has(id)), ...added].every((id, i) => id === after[i]);
    if (incremental) {
      for (const id of before) if (!wanted.has(id)) this.db.stmt('DELETE FROM deck_items WHERE deck_id=? AND study_item_id=?').run(deck.id.value, id);
    } else this.db.stmt('DELETE FROM deck_items WHERE deck_id=?').run(deck.id.value);
    for (const id of incremental ? added : after) this.db.stmt('INSERT INTO deck_items VALUES (?,?)').run(deck.id.value, id);
  }
  async findById(id: DeckId): Promise<Deck | null> {
    const row = this.db.stmt('SELECT * FROM decks WHERE id=?').get(id.value);
    return row ? this.deck(row) : null;
  }
  async findByParentId(parentId: DeckId): Promise<Deck[]> {
    return this.db.stmt('SELECT * FROM decks WHERE parent_id=? ORDER BY rowid').all(parentId.value).map(r => this.deck(r));
  }
  async findRoots(): Promise<Deck[]> {
    return this.db.stmt('SELECT * FROM decks WHERE parent_id IS NULL ORDER BY rowid').all().map(r => this.deck(r));
  }
  async findAll(): Promise<Deck[]> {
    return this.db.stmt('SELECT * FROM decks ORDER BY rowid').all().map(r => this.deck(r));
  }
  async remove(id: DeckId): Promise<void> {
    this.db.stmt('DELETE FROM deck_items WHERE deck_id=?').run(id.value);
    this.db.stmt('DELETE FROM decks WHERE id=?').run(id.value);
  }
  private items(deckId: string): string[] {
    return this.db.stmt('SELECT study_item_id FROM deck_items WHERE deck_id=? ORDER BY rowid').all(deckId).map(r => r.study_item_id as string);
  }
  private deck(r: Row): Deck {
    // Like the JSON store: an empty-string parent is not a root, but reads back as no parent.
    return Deck.reconstitute(new DeckId(r.id as string), r.name as string, r.parent_id ? new DeckId(r.parent_id as string) : null,
      this.items(r.id as string).map(id => new StudyItemId(id)));
  }
}

export class SqliteReviewLog implements ReviewLog {
  constructor(private readonly db: RecallDatabase) {}
  async append(review: Review): Promise<void> {
    this.db.stmt('INSERT INTO reviews (study_item_id, rating, timestamp) VALUES (?,?,?) ON CONFLICT DO NOTHING')
      .run(review.studyItemId.value, review.rating, review.timestamp.getTime());
  }
  async findByStudyItemId(studyItemId: StudyItemId): Promise<Review[]> {
    return this.db.stmt('SELECT * FROM reviews WHERE study_item_id=? ORDER BY timestamp, seq').all(studyItemId.value).map(r => this.review(r));
  }
  async findAll(): Promise<Review[]> {
    return this.db.stmt('SELECT * FROM reviews ORDER BY timestamp, seq').all().map(r => this.review(r));
  }
  async findSince(since: Date): Promise<Review[]> {
    return this.db.stmt('SELECT * FROM reviews WHERE timestamp>=? ORDER BY timestamp, seq').all(since.getTime()).map(r => this.review(r));
  }
  async countSince(since: Date): Promise<number> {
    return Number(this.db.stmt('SELECT COUNT(*) AS n FROM reviews WHERE timestamp>=?').get(since.getTime())!.n);
  }
  async countFirstReviewedSince(since: Date): Promise<number> {
    return Number(this.db.stmt(`SELECT COUNT(DISTINCT study_item_id) AS n FROM reviews r WHERE timestamp>=?
      AND NOT EXISTS (SELECT 1 FROM reviews p WHERE p.study_item_id=r.study_item_id AND p.timestamp<?)`).get(since.getTime(), since.getTime())!.n);
  }
  private review(r: Row): Review {
    return new Review(new StudyItemId(r.study_item_id as string), r.rating as Rating, new Date(r.timestamp as number));
  }
}
