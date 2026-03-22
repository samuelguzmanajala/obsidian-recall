import { StudyItemRepository } from '../domain/study-item-repository';
import { ConceptRepository } from '@context/concept/domain/concept-repository';
import { DeckRepository } from '@context/deck/domain/deck-repository';
import { ReviewLog } from '../domain/review-log';
import { DeckId } from '@context/deck/domain/deck-id';
import { DueStudyItemView } from './study-item-view';

export class GetDueStudyItemsByDeck {
  constructor(
    private readonly studyItemRepository: StudyItemRepository,
    private readonly conceptRepository: ConceptRepository,
    private readonly deckRepository: DeckRepository,
    private readonly reviewLog: ReviewLog,
  ) {}

  async execute(
    deckId: string,
    now: Date = new Date(),
    limits?: { maxNew: number; maxReview: number },
  ): Promise<DueStudyItemView[]> {
    const allDueItems = await this.studyItemRepository.findDue(now);
    const allowedIds = await this.collectStudyItemIds(new DeckId(deckId));

    const filteredItems = allDueItems.filter(item => allowedIds.has(item.id.value));
    const views: DueStudyItemView[] = [];

    for (const item of filteredItems) {
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

    const deduped = await this.deduplicateSiblings(views, now);
    return this.applyLimits(deduped, limits);
  }

  private applyLimits(
    views: DueStudyItemView[],
    limits?: { maxNew: number; maxReview: number },
  ): DueStudyItemView[] {
    if (!limits) return views;

    const result: DueStudyItemView[] = [];
    let newCount = 0;
    let reviewCount = 0;

    for (const view of views) {
      const isNew = view.reps === 0;
      if (isNew) {
        if (limits.maxNew > 0 && newCount >= limits.maxNew) continue;
        newCount++;
      } else {
        if (limits.maxReview > 0 && reviewCount >= limits.maxReview) continue;
        reviewCount++;
      }
      result.push(view);
    }

    return result;
  }

  private async deduplicateSiblings(views: DueStudyItemView[], now: Date): Promise<DueStudyItemView[]> {
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const todayReviews = await this.reviewLog.findSince(startOfDay);

    const reviewedByConceptToday = new Map<string, Set<string>>();
    const allItems = await this.studyItemRepository.findAll();
    for (const review of todayReviews) {
      const item = allItems.find(i => i.id.value === review.studyItemId.value);
      if (item) {
        const set = reviewedByConceptToday.get(item.conceptId.value) ?? new Set();
        set.add(review.studyItemId.value);
        reviewedByConceptToday.set(item.conceptId.value, set);
      }
    }

    const result: DueStudyItemView[] = [];
    for (const view of views) {
      const reviewedSiblings = reviewedByConceptToday.get(view.conceptId);
      if (!reviewedSiblings || reviewedSiblings.size === 0) {
        result.push(view);
        continue;
      }
      if (reviewedSiblings.has(view.studyItemId)) {
        result.push(view);
      }
    }

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
      const childIds = await this.collectStudyItemIds(child.id);
      for (const id of childIds) {
        ids.add(id);
      }
    }

    return ids;
  }
}
