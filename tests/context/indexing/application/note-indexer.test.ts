import { describe, it, expect, beforeEach } from 'vitest';
import { NoteIndexer } from '@context/indexing/application/note-indexer';
import { DeckId } from '@context/deck/domain/deck-id';
import { createIndexer, documents } from './indexer-fixture';

describe('NoteIndexer', () => {
  let container: ReturnType<typeof createIndexer>;
  let sync: NoteIndexer;

  beforeEach(() => {
    container = createIndexer();
    sync = container.indexer;
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

  describe('sync state persistence', () => {
    it('should persist sync state after a sync', async () => {
      const { indexer: sync, stores } = createIndexer();

      const content = `---
tags:
  - German/vocabulary
---
- Aber:::Pero`;

      await sync.syncFile('vocab.md', content);

      const state = ((await documents(stores))['sync-state'] ?? null) as {
        fileIndices: Record<string, unknown>;
        tagToDeckId: Record<string, string>;
      } | null;

      expect(state).not.toBeNull();
      expect(Object.keys(state!.fileIndices)).toEqual(['vocab.md']);
      expect(state!.tagToDeckId).toHaveProperty('German');
      expect(state!.tagToDeckId).toHaveProperty('German/vocabulary');
    });

    it('should not duplicate data after simulated restart', async () => {
      const container1 = createIndexer();
      const sync1 = container1.indexer;

      const content = `---
tags:
  - German/vocabulary
---
- Aber:::Pero`;

      await sync1.syncFile('vocab.md', content);

      // Verify initial state
      const conceptsBefore = await container1.conceptRepository.findAll();
      expect(conceptsBefore).toHaveLength(1);

      // Simulate restart: new indexer and repositories, same stored documents
      const container2 = createIndexer(container1.stores);
      const sync2 = container2.indexer;

      // Re-sync the same file (as initialSync would do)
      await sync2.syncFile('vocab.md', content);

      // Should NOT have duplicates
      const conceptsAfter = await container2.conceptRepository.findAll();
      expect(conceptsAfter).toHaveLength(1);

      const studyItemsAfter = await container2.studyItemRepository.findAll();
      expect(studyItemsAfter).toHaveLength(2); // bidirectional = 2

      const decksAfter = await container2.deckRepository.findAll();
      expect(decksAfter).toHaveLength(2); // German + vocabulary
    });
  });

  describe('deck cleanup on removal', () => {
    it('should remove study items from decks when card is removed', async () => {
      const content1 = `---
tags:
  - German/vocabulary
---
- Aber:::Pero
- Arbeiten:::Trabajar`;

      await sync.syncFile('vocab.md', content1);

      const deckBefore = (await container.deckRepository.findAll()).find(d => d.name === 'vocabulary')!;
      expect(deckBefore.studyItemIds).toHaveLength(4);

      // Remove one card
      const content2 = `---
tags:
  - German/vocabulary
---
- Aber:::Pero`;

      await sync.syncFile('vocab.md', content2);

      const deckAfter = (await container.deckRepository.findAll()).find(d => d.name === 'vocabulary')!;
      expect(deckAfter.studyItemIds).toHaveLength(2);
    });

    it('should remove study items from decks when file is deleted', async () => {
      const content = `---
tags:
  - German/vocabulary
---
- Aber:::Pero`;

      await sync.syncFile('vocab.md', content);
      const deckBefore = (await container.deckRepository.findAll()).find(d => d.name === 'vocabulary')!;
      expect(deckBefore.studyItemIds).toHaveLength(2);

      await sync.removeFile('vocab.md');

      const deckAfter = (await container.deckRepository.findAll()).find(d => d.name === 'vocabulary')!;
      expect(deckAfter.studyItemIds).toHaveLength(0);
    });
  });

  describe('file rename', () => {
    it('should preserve study items when file is renamed', async () => {
      const content = `---
tags:
  - German/vocabulary
---
- Aber:::Pero`;

      await sync.syncFile('old-name.md', content);

      const itemsBefore = await container.studyItemRepository.findAll();
      expect(itemsBefore).toHaveLength(2);
      const idsBefore = itemsBefore.map(i => i.id.value).sort();

      // Rename: move index, then re-sync with new path
      await sync.renameFile('old-name.md', 'new-name.md');
      await sync.syncFile('new-name.md', content);

      const itemsAfter = await container.studyItemRepository.findAll();
      expect(itemsAfter).toHaveLength(2);
      const idsAfter = itemsAfter.map(i => i.id.value).sort();

      // Same IDs — history preserved
      expect(idsAfter).toEqual(idsBefore);
    });
  });

  describe('untagged files', () => {
    it('should assign cards to Untagged deck when file has no tags', async () => {
      const content = '- Aber:::Pero';

      await sync.syncFile('no-tags.md', content);

      const decks = await container.deckRepository.findAll();
      expect(decks).toHaveLength(1);
      expect(decks[0].name).toBe('Untagged');
      expect(decks[0].studyItemIds).toHaveLength(2);
    });
  });

  describe('tag change detection', () => {
    it('should reassign study items when tags change', async () => {
      const content1 = `---
tags:
  - German/vocabulary
---
- Aber:::Pero`;

      await sync.syncFile('vocab.md', content1);

      const vocabDeck = (await container.deckRepository.findAll()).find(d => d.name === 'vocabulary')!;
      expect(vocabDeck.studyItemIds).toHaveLength(2);

      // Change tag from vocabulary to grammar
      const content2 = `---
tags:
  - German/grammar
---
- Aber:::Pero`;

      await sync.syncFile('vocab.md', content2);

      const decks = await container.deckRepository.findAll();
      // Should have 3 decks: German, vocabulary (now empty), grammar
      const grammarDeck = decks.find(d => d.name === 'grammar')!;
      expect(grammarDeck).toBeDefined();
      expect(grammarDeck.studyItemIds).toHaveLength(2);

      // Old deck should be empty
      const vocabDeckAfter = decks.find(d => d.name === 'vocabulary')!;
      expect(vocabDeckAfter.studyItemIds).toHaveLength(0);
    });
  });

  describe('deck hierarchy repair', () => {
    it('should recreate a missing parent deck when a child still points to it', async () => {
      const content = `---
tags:
  - German/grammar
---
- Aber:::Pero`;

      await sync.syncFile('grammar.md', content);

      const germanId = await sync.computeDeterministicId('deck:German');
      await container.deckRepository.remove(new DeckId(germanId));

      await sync.syncFile('grammar.md', content);

      const german = await container.deckRepository.findById(new DeckId(germanId));
      expect(german).not.toBeNull();
      expect(german!.name).toBe('German');
      expect(german!.parentId).toBeNull();
    });
  });
});
