import { describe, it, expect } from 'vitest';
import { Deck } from '@context/deck/domain/deck';
import { DeckId } from '@context/deck/domain/deck-id';
import { StudyItemId } from '@context/study/domain/study-item-id';

describe('Deck', () => {
  const id = new DeckId(crypto.randomUUID());
  const parentId = new DeckId(crypto.randomUUID());

  it('should create a root deck', () => {
    const deck = Deck.create(id, 'Idiomas');

    expect(deck.id).toBe(id);
    expect(deck.name).toBe('Idiomas');
    expect(deck.isRoot).toBe(true);
    expect(deck.parentId).toBeNull();
    expect(deck.studyItemIds).toHaveLength(0);
  });

  it('should create a child deck', () => {
    const deck = Deck.create(id, 'Alemán', parentId);

    expect(deck.isRoot).toBe(false);
    expect(deck.parentId).toBe(parentId);
  });

  it('should reject empty name', () => {
    expect(() => Deck.create(id, '')).toThrow('Deck name cannot be empty');
  });

  it('should reject whitespace-only name', () => {
    expect(() => Deck.create(id, '   ')).toThrow('Deck name cannot be empty');
  });

  it('should rename', () => {
    const deck = Deck.create(id, 'Idiomas');

    deck.rename('Languages');

    expect(deck.name).toBe('Languages');
  });

  it('should reject empty rename', () => {
    const deck = Deck.create(id, 'Idiomas');

    expect(() => deck.rename('')).toThrow('Deck name cannot be empty');
  });

  it('should nest under a parent', () => {
    const deck = Deck.create(id, 'Alemán');

    deck.nest(parentId);

    expect(deck.parentId).toBe(parentId);
    expect(deck.isRoot).toBe(false);
  });

  it('should not nest under itself', () => {
    const deck = Deck.create(id, 'Alemán');

    expect(() => deck.nest(id)).toThrow('A deck cannot be its own parent');
  });

  it('should unparent to become root', () => {
    const deck = Deck.create(id, 'Alemán', parentId);

    deck.unparent();

    expect(deck.isRoot).toBe(true);
  });

  it('should add a study item', () => {
    const deck = Deck.create(id, 'Alemán');
    const studyItemId = new StudyItemId(crypto.randomUUID());

    deck.addStudyItem(studyItemId);

    expect(deck.hasStudyItem(studyItemId)).toBe(true);
    expect(deck.studyItemIds).toHaveLength(1);
  });

  it('should not duplicate study items', () => {
    const deck = Deck.create(id, 'Alemán');
    const studyItemId = new StudyItemId(crypto.randomUUID());

    deck.addStudyItem(studyItemId);
    deck.addStudyItem(studyItemId);

    expect(deck.studyItemIds).toHaveLength(1);
  });

  it('should remove a study item', () => {
    const deck = Deck.create(id, 'Alemán');
    const studyItemId = new StudyItemId(crypto.randomUUID());

    deck.addStudyItem(studyItemId);
    deck.removeStudyItem(studyItemId);

    expect(deck.hasStudyItem(studyItemId)).toBe(false);
    expect(deck.studyItemIds).toHaveLength(0);
  });
});
