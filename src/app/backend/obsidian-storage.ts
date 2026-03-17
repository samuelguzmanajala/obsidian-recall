import { App } from 'obsidian';
import { JsonFilePort, SerializedReview } from '@context/shared/infrastructure/json-storage';
import { ReviewFilePort } from '@context/study/infrastructure/json-review-log';

const RECALL_DATA_DIR = 'recall-data';
const DEVICE_ID_PATH = '.obsidian/plugins/obsidian-recall/device-id';

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

/**
 * Get or create a stable device ID. Stored in the plugin dir
 * (NOT in data.json, NOT in .recall/) so it doesn't sync.
 */
export async function getDeviceId(app: App): Promise<string> {
  try {
    const existing = await app.vault.adapter.read(DEVICE_ID_PATH);
    if (existing.trim()) return existing.trim();
  } catch {
    // doesn't exist yet
  }

  const id = crypto.randomUUID().slice(0, 8); // short for filename
  try {
    await app.vault.adapter.write(DEVICE_ID_PATH, id);
  } catch {
    // Plugin dir might not exist yet — write will work after plugin loads
  }
  return id;
}

/**
 * Creates a ReviewFilePort that writes to a per-device file
 * and reads ALL device review files for replay.
 */
export function createReviewFilePort(app: App, deviceId: string): ReviewFilePort {
  const localPath = `${RECALL_DATA_DIR}/reviews-${deviceId}.json`;

  return {
    async readLocal(): Promise<SerializedReview[]> {
      try {
        const content = await app.vault.adapter.read(localPath);
        return JSON.parse(content) as SerializedReview[];
      } catch {
        return [];
      }
    },

    async writeLocal(reviews: SerializedReview[]): Promise<void> {
      try {
        await app.vault.adapter.mkdir(RECALL_DATA_DIR);
      } catch {
        // already exists
      }
      await app.vault.adapter.write(localPath, JSON.stringify(reviews));
    },

    async readAll(): Promise<SerializedReview[]> {
      const allReviews: SerializedReview[] = [];
      try {
        const files = await app.vault.adapter.list(RECALL_DATA_DIR);
        for (const file of files.files) {
          if (file.startsWith(`${RECALL_DATA_DIR}/reviews-`) && file.endsWith('.json')) {
            try {
              const content = await app.vault.adapter.read(file);
              const reviews = JSON.parse(content) as SerializedReview[];
              allReviews.push(...reviews);
            } catch {
              // skip corrupted files
            }
          }
        }
      } catch {
        // .recall/ doesn't exist yet
      }

      // Also read legacy reviews.json if it exists
      try {
        const legacy = await app.vault.adapter.read(`${RECALL_DATA_DIR}/reviews.json`);
        const legacyReviews = JSON.parse(legacy) as SerializedReview[];
        allReviews.push(...legacyReviews);
      } catch {
        // no legacy file
      }

      return allReviews;
    },
  };
}
