import { describe, expect, it, vi } from 'vitest';
import { RemoteClient } from '../../../src/app/backend/remote-client';
import { DEFAULT_SETTINGS, loadPluginSettings } from '../../../src/app/backend/plugin-settings';
import type { StudyClient } from '../../../src/app/backend/study-client';

const configured = () => loadPluginSettings({ backend: { url: 'http://localhost:27124', token: 'test', syncNotes: false } });

describe('RemoteClient without a configured backend', () => {
  it('reports the not-configured state and never calls the network', async () => {
    const transport = vi.fn();
    const client: StudyClient = new RemoteClient(structuredClone(DEFAULT_SETTINGS), transport);
    expect(client.isConfigured()).toBe(false);
    await expect(client.getDueStudyItems.execute()).rejects.toThrow('Configure the Recall backend URL and token');
    await expect(client.getDeckTree.execute()).rejects.toThrow('Configure the Recall backend URL and token');
    expect(client.hasPendingReview()).toBe(false);
    await expect(client.retryPendingReviews()).resolves.toBeUndefined();
    expect(transport).not.toHaveBeenCalled();
  });

  it('needs both URL and token; the legacy enabled flag is irrelevant', () => {
    const urlOnly = loadPluginSettings({ backend: { enabled: true, url: 'http://localhost:27124' } });
    expect(new RemoteClient(urlOnly).isConfigured()).toBe(false);
    expect(new RemoteClient(configured()).isConfigured()).toBe(true);
  });
});

describe('RemoteClient study port', () => {
  it('maps note sources reported by the backend', async () => {
    const transport = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).endsWith('/sources')
      ? { fileIndices: { 'Folder/Note.md': { cardKeys: { k: 'concept-1' }, conceptLines: { 'concept-1': 7 }, studyItemIds: [], deckIds: [] } }, tagToDeckId: {} }
      : { decks: [] })));
    const client = new RemoteClient(configured(), transport as typeof fetch);
    expect(client.findSource('concept-1')).toBeNull();
    await client.getDeckTree.execute();
    expect(client.findSource('concept-1')).toEqual({ filePath: 'Folder/Note.md', line: 7 });
  });

  it('toggles expanded decks and hands them to the persistence hook', () => {
    const client = new RemoteClient(configured());
    const persisted: string[][] = [];
    client.persistExpandedDecks = async ids => { persisted.push(ids); };
    client.toggleDeckExpanded('a');
    client.toggleDeckExpanded('b');
    client.toggleDeckExpanded('a');
    expect(client.expandedDeckIds).toEqual(['b']);
    expect(persisted).toEqual([['a'], ['a', 'b'], ['b']]);
  });
});
