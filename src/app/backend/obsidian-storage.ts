import { App } from 'obsidian';
import { JsonFilePort } from '@context/shared/infrastructure/json-storage';

const PLUGIN_DATA_DIR = '.obsidian/plugins/obsidian-recall/data';

/**
 * Creates a JsonFilePort backed by a file in the plugin's data directory.
 * Each aggregate gets its own JSON file.
 */
export function createObsidianFilePort(app: App, filename: string): JsonFilePort {
  const path = `${PLUGIN_DATA_DIR}/${filename}`;

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
      const dir = path.substring(0, path.lastIndexOf('/'));
      try {
        await app.vault.adapter.mkdir(dir);
      } catch {
        // dir already exists
      }
      await app.vault.adapter.write(path, JSON.stringify(data));
    },
  };
}
