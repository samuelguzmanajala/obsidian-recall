export abstract class Identifier {
  constructor(readonly value: string) {
    if (!value || value.trim().length === 0) {
      throw new Error('Identifier cannot be empty');
    }
  }

  equals(other: Identifier): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
