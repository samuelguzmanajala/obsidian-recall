import { Direction } from '../domain/direction';

export interface SchedulePreviewView {
  againDays: number;
  hardDays: number;
  goodDays: number;
  easyDays: number;
}

export interface DueStudyItemView {
  /** Server concurrency token. Never infer it from reps or timestamps. */
  revision?: number;
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
  /** Optional — populated when the use case has a Scheduler available. */
  preview?: SchedulePreviewView;
}
