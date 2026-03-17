import { Review } from '../domain/review';
import { ReviewLog } from '../domain/review-log';
import { StudyItemId } from '../domain/study-item-id';
import { Rating } from '../domain/rating';
import { JsonFilePort, SerializedReview } from '@context/shared/infrastructure/json-storage';

export class JsonReviewLog implements ReviewLog {
  private cache: SerializedReview[] | null = null;
  private batchMode = false;

  constructor(private readonly file: JsonFilePort) {}

  setBatchMode(on: boolean): void {
    this.batchMode = on;
  }

  async flush(): Promise<void> {
    this.batchMode = false;
    await this.persist();
  }

  private async load(): Promise<SerializedReview[]> {
    if (!this.cache) {
      this.cache = (await this.file.read<SerializedReview[]>()) ?? [];
    }
    return this.cache;
  }

  private async persist(): Promise<void> {
    if (this.cache && !this.batchMode) {
      await this.file.write(this.cache);
    }
  }

  async append(review: Review): Promise<void> {
    const store = await this.load();
    // Dedup: don't add if same studyItemId+timestamp already exists
    const key = this.reviewKey(review);
    const exists = store.some(r => this.serializedKey(r) === key);
    if (!exists) {
      store.push(this.serialize(review));
      await this.persist();
    }
  }

  /**
   * Merge reviews from another source (e.g. after Sync conflict).
   * Adds only reviews not already present (by studyItemId+timestamp).
   */
  async mergeFrom(reviews: SerializedReview[]): Promise<number> {
    const store = await this.load();
    const existingKeys = new Set(store.map(r => this.serializedKey(r)));
    let added = 0;

    for (const review of reviews) {
      const key = this.serializedKey(review);
      if (!existingKeys.has(key)) {
        store.push(review);
        existingKeys.add(key);
        added++;
      }
    }

    if (added > 0) {
      // Sort by timestamp for consistency
      store.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      await this.persist();
    }

    return added;
  }

  private reviewKey(review: Review): string {
    return `${review.studyItemId.value}:${review.timestamp.getTime()}`;
  }

  private serializedKey(raw: SerializedReview): string {
    return `${raw.studyItemId}:${new Date(raw.timestamp).getTime()}`;
  }

  async findByStudyItemId(studyItemId: StudyItemId): Promise<Review[]> {
    const store = await this.load();
    return store
      .filter(raw => raw.studyItemId === studyItemId.value)
      .map(raw => this.deserialize(raw));
  }

  async findAll(): Promise<Review[]> {
    const store = await this.load();
    return store.map(raw => this.deserialize(raw));
  }

  async clear(): Promise<void> {
    this.cache = [];
    await this.persist();
  }

  async findSince(since: Date): Promise<Review[]> {
    const store = await this.load();
    return store
      .filter(raw => new Date(raw.timestamp) >= since)
      .map(raw => this.deserialize(raw));
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
