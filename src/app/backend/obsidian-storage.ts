import { App } from 'obsidian';
import { JsonFilePort } from '@context/shared/infrastructure/json-storage';

const RECALL_DATA_DIR = '.recall';

/**
 * Creates a JsonFilePort backed by a file in the .recall/ vault directory.
 * Uses vault adapter so files are visible to Obsidian Sync.
 * Each aggregate gets its own JSON file.
 */
export function createObsidianFilePort(app: App, filename: string): JsonFilePort {
  const path = `${RECALL_DATA_DIR}/${filename}`;

  return {
    async read<T>(): Promise<T | null> {
      try {
        const content = await app.vault.adapter.read(path);
        return JSON.parse(content) as T;
      } catch {
        return null;
      }
    },

    async write<T>(data: T): Promise<void> {
      try {
        await app.vault.adapter.mkdir(RECALL_DATA_DIR);
      } catch {
        // dir already exists
      }
      await app.vault.adapter.write(path, JSON.stringify(data));
    },
  };
}
