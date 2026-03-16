export class MemoryState {
  constructor(
    readonly stability: number,
    readonly difficulty: number,
    readonly due: Date,
    readonly reps: number,
    readonly lapses: number,
    readonly lastReview: Date | null,
  ) {}

  get isDue(): boolean {
    return this.due <= new Date();
  }

  static initial(): MemoryState {
    return new MemoryState(0, 0, new Date(), 0, 0, null);
  }

  equals(other: MemoryState): boolean {
    return (
      this.stability === other.stability &&
      this.difficulty === other.difficulty &&
      this.due.getTime() === other.due.getTime() &&
      this.reps === other.reps &&
      this.lapses === other.lapses
    );
  }
}
