import { StudyItemId } from './study-item-id';
import { Rating } from './rating';

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
