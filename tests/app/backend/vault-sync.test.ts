import { describe, it, expect, beforeEach } from 'vitest';
import { Container } from '@app/backend/container';
import { VaultSync } from '@app/backend/vault-sync';
import { createTestStorageFiles } from '../../context/shared/infrastructure/in-memory-json-storage';

describe('VaultSync', () => {
  let container: Container;
  let sync: VaultSync;

  beforeEach(() => {
    container = new Container(createTestStorageFiles());
    sync = new VaultSync(container);
  });

  it('should create concepts and study items from a markdown file', async () => {
    const content = [
      '# Vocabulario',
      '- Aber:::Pero',
      '- Arbeiten:::Trabajar',
    ].join('\n');

    await sync.syncFile('vocab.md', content);

    const concepts = await container.conceptRepository.findAll();
    expect(concepts).toHaveLength(2);

    const studyItems = await container.studyItemRepository.findAll();
    expect(studyItems).toHaveLength(4);
  });

  it('should create 1 study item for unidirectional card', async () => {
    const content = '- What is DDD?::Domain-Driven Design';

    await sync.syncFile('ddd.md', content);

    const concepts = await container.conceptRepository.findAll();
    expect(concepts).toHaveLength(1);

    const studyItems = await container.studyItemRepository.findAll();
    expect(studyItems).toHaveLength(1);
  });

  it('should not duplicate concepts on re-sync', async () => {
    const content = '- Aber:::Pero';

    await sync.syncFile('vocab.md', content);
    await sync.syncFile('vocab.md', content);

    const concepts = await container.conceptRepository.findAll();
    expect(concepts).toHaveLength(1);
  });

  it('should remove concepts when cards are deleted from file', async () => {
    const content1 = '- Aber:::Pero\n- Arbeiten:::Trabajar';
    await sync.syncFile('vocab.md', content1);

    const content2 = '- Aber:::Pero';
    await sync.syncFile('vocab.md', content2);

    const concepts = await container.conceptRepository.findAll();
    expect(concepts).toHaveLength(1);
    expect(concepts[0].sideA.content).toBe('Aber');

    const studyItems = await container.studyItemRepository.findAll();
    expect(studyItems).toHaveLength(2);
  });

  it('should remove all concepts when file is deleted', async () => {
    const content = '- Aber:::Pero\n- Arbeiten:::Trabajar';
    await sync.syncFile('vocab.md', content);

    await sync.removeFile('vocab.md');

    const concepts = await container.conceptRepository.findAll();
    expect(concepts).toHaveLength(0);

    const studyItems = await container.studyItemRepository.findAll();
    expect(studyItems).toHaveLength(0);
  });

  it('should handle file with no cards', async () => {
    const content = '# Just a regular note\nSome text without cards';

    await sync.syncFile('note.md', content);

    const concepts = await container.conceptRepository.findAll();
    expect(concepts).toHaveLength(0);
  });

  describe('tag-based decks', () => {
    it('should create deck hierarchy from tags', async () => {
      const content = `---
tags:
  - German
  - German/grammar
---
- Aber:::Pero`;

      await sync.syncFile('grammar.md', content);

      const decks = await container.deckRepository.findAll();
      expect(decks).toHaveLength(2);

      const roots = await container.deckRepository.findRoots();
      expect(roots).toHaveLength(1);
      expect(roots[0].name).toBe('German');
    });

    it('should assign study items to leaf decks', async () => {
      const content = `---
tags:
  - German/vocabulary
---
- Aber:::Pero`;

      await sync.syncFile('vocab.md', content);

      const decks = await container.deckRepository.findAll();
      const vocabDeck = decks.find(d => d.name === 'vocabulary');
      expect(vocabDeck).toBeDefined();
      expect(vocabDeck!.studyItemIds).toHaveLength(2);
    });

    it('should not duplicate decks across files with same tag', async () => {
      const content1 = `---
tags:
  - German/vocabulary
---
- Aber:::Pero`;

      const content2 = `---
tags:
  - German/vocabulary
---
- Arbeiten:::Trabajar`;

      await sync.syncFile('vocab1.md', content1);
      await sync.syncFile('vocab2.md', content2);

      const decks = await container.deckRepository.findAll();
      expect(decks).toHaveLength(2);

      const vocabDeck = decks.find(d => d.name === 'vocabulary');
      expect(vocabDeck!.studyItemIds).toHaveLength(4);
    });
  });
});
