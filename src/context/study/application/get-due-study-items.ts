import { StudyItemRepository } from '../domain/study-item-repository';
import { ConceptRepository } from '@context/concept/domain/concept-repository';
import { ReviewLog } from '../domain/review-log';
import { Scheduler } from '../domain/scheduler';
import { Rating } from '../domain/rating';
import { DueStudyItemView, SchedulePreviewView } from './study-item-view';

export class GetDueStudyItems {
  constructor(
    private readonly studyItemRepository: StudyItemRepository,
    private readonly conceptRepository: ConceptRepository,
    private readonly reviewLog: ReviewLog,
    private readonly scheduler: Scheduler | null = null,
  ) {}

  async execute(
    now: Date = new Date(),
    limits?: { maxNew: number; maxReview: number },
  ): Promise<DueStudyItemView[]> {
    const dueItems = await this.studyItemRepository.findDue(now);
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
        preview: this.scheduler ? buildPreview(this.scheduler, item.memoryState, now) : undefined,
      });
    }

    const deduped = await this.deduplicateSiblings(views, now);
    const adjustedLimits = await this.adjustForIntroducedToday(limits, now);
    return this.applyLimits(deduped, adjustedLimits);
  }

  /**
   * Subtract from `maxNew` the number of study items that had their FIRST
   * review today. Without this, the cap is enforced only per /due call —
   * a user doing several sessions a day (or whose buffer refills mid-session)
   * would be served fresh batches of "new" cards each time, busting the
   * intended daily ceiling.
   */
  private async adjustForIntroducedToday(
    limits: { maxNew: number; maxReview: number } | undefined,
    now: Date,
  ): Promise<{ maxNew: number; maxReview: number } | undefined> {
    if (!limits || limits.maxNew === 0) return limits;

    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    const all = await this.reviewLog.findAll();
    const earliestByItem = new Map<string, Date>();
    for (const r of all) {
      const cur = earliestByItem.get(r.studyItemId.value);
      if (!cur || r.timestamp < cur) earliestByItem.set(r.studyItemId.value, r.timestamp);
    }

    let introducedToday = 0;
    for (const earliest of earliestByItem.values()) {
      if (earliest >= startOfDay) introducedToday++;
    }

    return {
      maxNew: Math.max(0, limits.maxNew - introducedToday),
      maxReview: limits.maxReview,
    };
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

  /**
   * When both directions of a bidirectional concept are due, only show one.
   * Uses today's review log to decide: if one direction was already reviewed
   * today, exclude the other. If neither was reviewed, pick one at random.
   */
  /**
   * Sibling dedup: only one direction of a bidirectional concept per day.
   * Uses today's review log — if direction A was reviewed today,
   * direction B is excluded even if it's due (and vice versa).
   */
  private async deduplicateSiblings(views: DueStudyItemView[], now: Date): Promise<DueStudyItemView[]> {
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const todayReviews = await this.reviewLog.findSince(startOfDay);

    // Build a map: conceptId → set of studyItemIds reviewed today
    const reviewedByConceptToday = new Map<string, Set<string>>();
    for (const review of todayReviews) {
      // Need to find conceptId for this studyItemId — check in our views first
      const view = views.find(v => v.studyItemId === review.studyItemId.value);
      if (view) {
        const set = reviewedByConceptToday.get(view.conceptId) ?? new Set();
        set.add(review.studyItemId.value);
        reviewedByConceptToday.set(view.conceptId, set);
      }
    }

    // Also check items not in views (sibling was reviewed but its due moved to future)
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
}

import type { MemoryState } from '../domain/memory-state';

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
