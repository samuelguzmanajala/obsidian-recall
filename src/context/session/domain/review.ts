import { StudyItemId } from '@context/study/domain/study-item-id';
import { Rating } from '@context/study/domain/rating';

export class Review {
  constructor(
    readonly studyItemId: StudyItemId,
    readonly rating: Rating,
    readonly timestamp: Date,
  ) {}

  equals(other: Review): boolean {
    return (
      this.studyItemId.equals(other.studyItemId) &&
      this.rating === other.rating &&
      this.timestamp.getTime() === other.timestamp.getTime()
    );
  }
}
