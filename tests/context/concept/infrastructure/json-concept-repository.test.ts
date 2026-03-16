import { describe, it, expect, beforeEach } from 'vitest';
import { JsonConceptRepository } from '@context/concept/infrastructure/json-concept-repository';
import { InMemoryJsonFile } from '../../shared/infrastructure/in-memory-json-storage';
import { Concept } from '@context/concept/domain/concept';
import { ConceptId } from '@context/concept/domain/concept-id';
import { Side } from '@context/concept/domain/side';
import { Directionality } from '@context/concept/domain/directionality';

describe('JsonConceptRepository', () => {
  let repository: JsonConceptRepository;

  beforeEach(() => {
    repository = new JsonConceptRepository(new InMemoryJsonFile());
  });

  const createConcept = (id: string = crypto.randomUUID()) =>
    Concept.create(
      new ConceptId(id),
      new Side('Aber'),
      new Side('Pero'),
      Directionality.Bidirectional,
    );

  it('should save and find a concept', async () => {
    const concept = createConcept();
    await repository.save(concept);

    const found = await repository.findById(concept.id);

    expect(found).not.toBeNull();
    expect(found!.id.value).toBe(concept.id.value);
    expect(found!.sideA.content).toBe('Aber');
    expect(found!.sideB.content).toBe('Pero');
    expect(found!.isBidirectional).toBe(true);
  });

  it('should return null for non-existent concept', async () => {
    const found = await repository.findById(new ConceptId('non-existent'));
    expect(found).toBeNull();
  });

  it('should find all concepts', async () => {
    await repository.save(createConcept());
    await repository.save(createConcept());

    const all = await repository.findAll();
    expect(all).toHaveLength(2);
  });

  it('should remove a concept', async () => {
    const concept = createConcept();
    await repository.save(concept);
    await repository.remove(concept.id);

    const found = await repository.findById(concept.id);
    expect(found).toBeNull();
  });

  it('should overwrite on save with same id', async () => {
    const id = crypto.randomUUID();
    const concept1 = Concept.create(
      new ConceptId(id),
      new Side('Old'),
      new Side('Value'),
      Directionality.Unidirectional,
    );
    const concept2 = Concept.create(
      new ConceptId(id),
      new Side('New'),
      new Side('Value'),
      Directionality.Bidirectional,
    );

    await repository.save(concept1);
    await repository.save(concept2);

    const found = await repository.findById(new ConceptId(id));
    expect(found!.sideA.content).toBe('New');
    expect(found!.isBidirectional).toBe(true);
  });
});
