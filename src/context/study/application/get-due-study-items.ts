import { StudyItemRepository } from '../domain/study-item-repository';
import { ConceptRepository } from '@context/concept/domain/concept-repository';
import { DeckRepository } from '@context/deck/domain/deck-repository';
import { DeckId } from '@context/deck/domain/deck-id';
import { ReviewLog } from '../domain/review-log';
import { Scheduler } from '../domain/scheduler';
import { Rating } from '../domain/rating';
import { MemoryState } from '../domain/memory-state';
import { DueStudyItemView, SchedulePreviewView } from './study-item-view';

export class GetDueStudyItems {
  constructor(
    private readonly studyItemRepository: StudyItemRepository,
    private readonly conceptRepository: ConceptRepository,
    private readonly deckRepository: DeckRepository,
    private readonly reviewLog: ReviewLog,
    private readonly scheduler: Scheduler | null = null,
  ) {}

  /**
   * Due study items in storage order, optionally restricted to a deck and its sub-decks,
   * showing one direction per concept per day. Previews are added by `withPreview`, so a
   * caller that keeps only part of the queue does not schedule every due card.
   */
  async execute(now: Date = new Date(), deckId?: string): Promise<DueStudyItemView[]> {
    let dueItems = await this.studyItemRepository.findDue(now);
    if (deckId) {
      const allowedIds = await this.collectStudyItemIds(new DeckId(deckId));
      dueItems = dueItems.filter(item => allowedIds.has(item.id.value));
    }
    const views: DueStudyItemView[] = [];

    for (const item of dueItems) {
      const concept = await this.conceptRepository.findById(item.conceptId);
      if (!concept) continue;

      views.push({
        studyItemId: item.id.value,
        conceptId: item.conceptId.value,
        sideA: concept.sideA.content,
        sideB: concept.sideB.content,
        direction: item.direction,
        due: item.memoryState.due,
        reps: item.memoryState.reps,
        lapses: item.memoryState.lapses,
        stability: item.memoryState.stability,
        difficulty: item.memoryState.difficulty,
        lastReview: item.memoryState.lastReview,
      });
    }

    return this.deduplicateSiblings(views, now);
  }

  /** Adds the interval preview (last property, as clients have always received it). */
  withPreview(view: DueStudyItemView, now: Date): DueStudyItemView {
    const state = new MemoryState(view.stability, view.difficulty, view.due, view.reps, view.lapses, view.lastReview);
    return { ...view, preview: this.scheduler ? buildPreview(this.scheduler, state, now) : undefined };
  }

  /**
   * Sibling dedup: only one direction of a bidirectional concept per day.
   * Uses today's review log — if direction A was reviewed today,
   * direction B is excluded even if it's due (and vice versa).
   */
  private async deduplicateSiblings(views: DueStudyItemView[], now: Date): Promise<DueStudyItemView[]> {
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const todayReviews = await this.reviewLog.findSince(startOfDay);

    // conceptId → set of studyItemIds reviewed today (including siblings whose due moved to the future)
    const reviewedByConceptToday = new Map<string, Set<string>>();
    const conceptOf = new Map<string, string | null>();
    for (const review of todayReviews) {
      const id = review.studyItemId.value;
      if (!conceptOf.has(id)) conceptOf.set(id, (await this.studyItemRepository.findById(review.studyItemId))?.conceptId.value ?? null);
      const conceptId = conceptOf.get(id);
      if (!conceptId) continue;
      const set = reviewedByConceptToday.get(conceptId) ?? new Set();
      set.add(id);
      reviewedByConceptToday.set(conceptId, set);
    }

    const result: DueStudyItemView[] = [];
    for (const view of views) {
      const reviewedSiblings = reviewedByConceptToday.get(view.conceptId);
      if (!reviewedSiblings || reviewedSiblings.size === 0) {
        // No sibling reviewed today — include
        result.push(view);
        continue;
      }

      if (reviewedSiblings.has(view.studyItemId)) {
        // This exact direction was reviewed today — include (learning steps)
        result.push(view);
      }
      // else: sibling was reviewed but not this one → exclude
    }

    // Handle case where no direction was reviewed yet but both are due
    // → pick one at random per concept
    const byConceptId = new Map<string, DueStudyItemView[]>();
    for (const view of result) {
      const group = byConceptId.get(view.conceptId) ?? [];
      group.push(view);
      byConceptId.set(view.conceptId, group);
    }

    const final: DueStudyItemView[] = [];
    const seenConcepts = new Set<string>();
    for (const view of result) {
      const group = byConceptId.get(view.conceptId)!;
      if (group.length <= 1) {
        final.push(view);
        continue;
      }
      // Multiple directions due, none reviewed yet → pick one
      if (!seenConcepts.has(view.conceptId)) {
        seenConcepts.add(view.conceptId);
        const pick = group[Math.floor(Math.random() * group.length)];
        final.push(pick);
      }
    }

    return final;
  }

  private async collectStudyItemIds(deckId: DeckId): Promise<Set<string>> {
    const ids = new Set<string>();

    const deck = await this.deckRepository.findById(deckId);
    if (!deck) return ids;

    for (const si of deck.studyItemIds) {
      ids.add(si.value);
    }

    const children = await this.deckRepository.findByParentId(deckId);
    for (const child of children) {
      for (const id of await this.collectStudyItemIds(child.id)) {
        ids.add(id);
      }
    }

    return ids;
  }
}

export function buildPreview(scheduler: Scheduler, state: MemoryState, now: Date): SchedulePreviewView {
  const previews = scheduler.previewAll(state, now);
  const byRating = (r: Rating) => previews.find((p) => p.rating === r)?.intervalDays ?? 0;
  return {
    againDays: byRating(Rating.Again),
    hardDays: byRating(Rating.Hard),
    goodDays: byRating(Rating.Good),
    easyDays: byRating(Rating.Easy),
  };
}
