import { describe, it, expect } from 'vitest';
import { Concept } from '../concept';
import { ConceptId } from '../concept-id';
import { Side } from '../side';
import { Directionality } from '../directionality';

describe('Concept', () => {
  const id = new ConceptId('concept-1');
  const sideA = new Side('What is FSRS?');
  const sideB = new Side('Free Spaced Repetition Scheduler');

  it('should create a unidirectional concept', () => {
    const concept = Concept.create(id, sideA, sideB, Directionality.Unidirectional);

    expect(concept.id.value).toBe('concept-1');
    expect(concept.sideA.content).toBe('What is FSRS?');
    expect(concept.sideB.content).toBe('Free Spaced Repetition Scheduler');
    expect(concept.isBidirectional).toBe(false);
  });

  it('should create a bidirectional concept', () => {
    const concept = Concept.create(id, sideA, sideB, Directionality.Bidirectional);

    expect(concept.isBidirectional).toBe(true);
  });

  it('should update sides', () => {
    const concept = Concept.create(id, sideA, sideB, Directionality.Unidirectional);
    const newSideA = new Side('Updated question');
    const newSideB = new Side('Updated answer');

    concept.updateSides(newSideA, newSideB);

    expect(concept.sideA.content).toBe('Updated question');
    expect(concept.sideB.content).toBe('Updated answer');
  });

  it('should change directionality', () => {
    const concept = Concept.create(id, sideA, sideB, Directionality.Unidirectional);

    concept.changeDirectionality(Directionality.Bidirectional);

    expect(concept.isBidirectional).toBe(true);
  });
});
