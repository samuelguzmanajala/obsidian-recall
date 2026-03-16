import { Plugin } from 'obsidian';
import { JsonStoragePort, StorageData, emptyStorageData } from '@context/shared/infrastructure/json-storage';

/**
 * Obsidian-specific storage adapter.
 * Uses plugin.loadData/saveData which writes to .obsidian/plugins/<id>/data.json
 */
export class ObsidianStorage implements JsonStoragePort {
  constructor(private readonly plugin: Plugin) {}

  async load(): Promise<StorageData> {
    const raw = await this.plugin.loadData();
    if (!raw) return emptyStorageData();

    return {
      concepts: raw.concepts ?? {},
      studyItems: raw.studyItems ?? {},
      decks: raw.decks ?? {},
      reviews: raw.reviews ?? [],
    };
  }

  async save(data: StorageData): Promise<void> {
    await this.plugin.saveData(data);
  }
}
