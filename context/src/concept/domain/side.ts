export class Side {
  constructor(readonly content: string) {
    if (!content || content.trim().length === 0) {
      throw new Error('Side content cannot be empty');
    }
  }

  equals(other: Side): boolean {
    return this.content === other.content;
  }
}
