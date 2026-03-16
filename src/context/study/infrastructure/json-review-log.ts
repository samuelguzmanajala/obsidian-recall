import { Review } from '../domain/review';
import { ReviewLog } from '../domain/review-log';
import { StudyItemId } from '../domain/study-item-id';
import { Rating } from '../domain/rating';
import { JsonStoragePort, StorageData, SerializedReview } from '@context/shared/infrastructure/json-storage';

export class JsonReviewLog implements ReviewLog {
  private data: StorageData | null = null;

  constructor(private readonly storage: JsonStoragePort) {}

  private async getData(): Promise<StorageData> {
    if (!this.data) {
      this.data = await this.storage.load();
    }
    return this.data;
  }

  async append(review: Review): Promise<void> {
    const data = await this.getData();
    data.reviews.push(this.serialize(review));
    await this.storage.save(data);
  }

  async findByStudyItemId(studyItemId: StudyItemId): Promise<Review[]> {
    const data = await this.getData();
    return data.reviews
      .filter(raw => raw.studyItemId === studyItemId.value)
      .map(raw => this.deserialize(raw));
  }

  async findAll(): Promise<Review[]> {
    const data = await this.getData();
    return data.reviews.map(raw => this.deserialize(raw));
  }

  async findSince(since: Date): Promise<Review[]> {
    const data = await this.getData();
    return data.reviews
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
