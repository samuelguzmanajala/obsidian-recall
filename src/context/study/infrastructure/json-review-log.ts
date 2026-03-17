import { Review } from '../domain/review';
import { ReviewLog } from '../domain/review-log';
import { StudyItemId } from '../domain/study-item-id';
import { Rating } from '../domain/rating';
import { SerializedReview } from '@context/shared/infrastructure/json-storage';
/**
 * Port for reading/writing review files per device.
 * Each device gets its own file: recall-data/reviews-{deviceId}.json
 * Replay reads ALL device files to reconstruct state.
 */
export interface ReviewDeviceStorage {
  /** Read this device's review file */
  readLocal(): Promise<SerializedReview[]>;
  /** Write this device's review file */
  writeLocal(reviews: SerializedReview[]): Promise<void>;
  /** Read ALL review files from all devices */
  readAll(): Promise<SerializedReview[]>;
}

export class MultiDeviceReviewLog implements ReviewLog {
  private cache: SerializedReview[] | null = null;
  private allCache: Review[] | null = null;
  private batchMode = false;

  constructor(private readonly port: ReviewDeviceStorage) {}

  setBatchMode(on: boolean): void {
    this.batchMode = on;
  }

  async flush(): Promise<void> {
    this.batchMode = false;
    await this.persist();
  }

  private async loadLocal(): Promise<SerializedReview[]> {
    if (!this.cache) {
      this.cache = await this.port.readLocal();
    }
    return this.cache;
  }

  private async persist(): Promise<void> {
    if (this.cache && !this.batchMode) {
      await this.port.writeLocal(this.cache);
    }
  }

  async append(review: Review): Promise<void> {
    const store = await this.loadLocal();
    const key = this.reviewKey(review);
    const exists = store.some(r => this.serializedKey(r) === key);
    if (!exists) {
      store.push(this.serialize(review));
      this.allCache = null; // invalidate all-devices cache
      await this.persist();
    }
  }

  async findByStudyItemId(studyItemId: StudyItemId): Promise<Review[]> {
    const all = await this.findAll();
    return all.filter(r => r.studyItemId.equals(studyItemId));
  }

  /**
   * Read ALL reviews from ALL devices. This is the source of truth
   * for replay — merges all device files, deduplicates, sorts.
   * Cached until a new review is appended locally.
   */
  async findAll(): Promise<Review[]> {
    if (!this.allCache) {
      const allRaw = await this.port.readAll();
      const deduped = this.dedup(allRaw);
      this.allCache = deduped.map(raw => this.deserialize(raw));
    }
    return this.allCache;
  }

  /** Force re-read from all device files (call after Sync updates) */
  invalidateCache(): void {
    this.allCache = null;
    this.cache = null;
  }

  async clear(): Promise<void> {
    this.cache = [];
    await this.persist();
  }

  async findSince(since: Date): Promise<Review[]> {
    const all = await this.findAll();
    return all.filter(r => r.timestamp >= since);
  }

  private dedup(reviews: SerializedReview[]): SerializedReview[] {
    const seen = new Set<string>();
    const result: SerializedReview[] = [];
    for (const r of reviews) {
      const key = this.serializedKey(r);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(r);
      }
    }
    result.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return result;
  }

  private reviewKey(review: Review): string {
    return `${review.studyItemId.value}:${review.timestamp.getTime()}`;
  }

  private serializedKey(raw: SerializedReview): string {
    return `${raw.studyItemId}:${new Date(raw.timestamp).getTime()}`;
  }

  private serialize(review: Review): SerializedReview {
    return {
      studyItemId: review.studyItemId.value,
      rating: review.rating,
      timestamp: review.timestamp.toISOString(),
    };
  }

  private deserialize(raw: SerializedReview): Review {
    return new Review(
      new StudyItemId(raw.studyItemId),
      raw.rating as Rating,
      new Date(raw.timestamp),
    );
  }
}
