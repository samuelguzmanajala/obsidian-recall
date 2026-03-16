import { Direction } from '../domain/direction';

export interface DueStudyItemView {
  studyItemId: string;
  conceptId: string;
  sideA: string;
  sideB: string;
  direction: Direction;
  due: Date;
  reps: number;
  lapses: number;
  stability: number;
  difficulty: number;
  lastReview: Date | null;
}
