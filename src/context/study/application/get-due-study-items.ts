import { StudyItemRepository } from '../domain/study-item-repository';
import { ConceptRepository } from '@context/concept/domain/concept-repository';
import { DueStudyItemView } from './study-item-view';

export class GetDueStudyItems {
  constructor(
    private readonly studyItemRepository: StudyItemRepository,
    private readonly conceptRepository: ConceptRepository,
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
      });
    }

    const deduped = this.deduplicateSiblings(views);
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

  /**
   * When both directions of a bidirectional concept are due the same day,
   * pick one at random and drop the other. They'll desync naturally after
   * the first review pushes one direction's due date forward.
   */
  private deduplicateSiblings(views: DueStudyItemView[]): DueStudyItemView[] {
    const byConceptId = new Map<string, DueStudyItemView[]>();

    for (const view of views) {
      const group = byConceptId.get(view.conceptId) ?? [];
      group.push(view);
      byConceptId.set(view.conceptId, group);
    }

    const result: DueStudyItemView[] = [];
    for (const group of byConceptId.values()) {
      if (group.length <= 1) {
        result.push(...group);
      } else {
        // Pick one at random
        const pick = group[Math.floor(Math.random() * group.length)];
        result.push(pick);
      }
    }

    return result;
  }
}
