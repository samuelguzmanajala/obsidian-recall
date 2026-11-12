import { StudyItemId } from './study-item-id';
import { Rating } from './rating';
import type { MemoryState } from './memory-state';

/**
 * Who recorded a review: the MCP connector (a conversational tutor), the Android app, the Obsidian
 * plugin, or another HTTP client of the backend. A label only; it never changes scheduling.
 */
export type ReviewOrigin = 'mcp' | 'android' | 'obsidian' | 'api';

export class Review {
  constructor(
    readonly studyItemId: StudyItemId,
    readonly rating: Rating,
    readonly timestamp: Date,
    /** `null` for reviews recorded before origins were kept, and for imported history. */
    readonly origin: ReviewOrigin | null = null,
    /**
     * The memory state this review was applied to. Lets a correction recompute a card from just
     * before the corrected review, also when its state does not come from its logged history
     * (imported). `null` for reviews recorded before priors were kept.
     */
    readonly prior: MemoryState | null = null,
  ) {}

  equals(other: Review): boolean {
    return (
      this.studyItemId.equals(other.studyItemId) &&
      this.rating === other.rating &&
      this.timestamp.getTime() === other.timestamp.getTime()
    );
  }
}
