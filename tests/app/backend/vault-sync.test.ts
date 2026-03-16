import { describe, it, expect, beforeEach } from 'vitest';
import { Container } from '@app/backend/container';
import { VaultSync } from '@app/backend/vault-sync';
import { InMemoryJsonStorage } from '../../context/shared/infrastructure/in-memory-json-storage';

describe('VaultSync', () => {
  let storage: InMemoryJsonStorage;
  let container: Container;
  let sync: VaultSync;

  beforeEach(() => {
    storage = new InMemoryJsonStorage();
    container = new Container(storage);
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

    // Bidirectional → 2 study items per concept = 4 total
    const data = await storage.load();
    expect(Object.keys(data.studyItems)).toHaveLength(4);
  });

  it('should create 1 study item for unidirectional card', async () => {
    const content = '- What is DDD?::Domain-Driven Design';

    await sync.syncFile('ddd.md', content);

    const data = await storage.load();
    expect(Object.keys(data.concepts)).toHaveLength(1);
    expect(Object.keys(data.studyItems)).toHaveLength(1);
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

    const data = await storage.load();
    expect(Object.keys(data.studyItems)).toHaveLength(2); // 1 bidirectional = 2 study items
  });

  it('should remove all concepts when file is deleted', async () => {
    const content = '- Aber:::Pero\n- Arbeiten:::Trabajar';
    await sync.syncFile('vocab.md', content);

    await sync.removeFile('vocab.md');

    const concepts = await container.conceptRepository.findAll();
    expect(concepts).toHaveLength(0);

    const data = await storage.load();
    expect(Object.keys(data.studyItems)).toHaveLength(0);
  });

  it('should handle file with no cards', async () => {
    const content = '# Just a regular note\nSome text without cards';

    await sync.syncFile('note.md', content);

    const concepts = await container.conceptRepository.findAll();
    expect(concepts).toHaveLength(0);
  });
});
