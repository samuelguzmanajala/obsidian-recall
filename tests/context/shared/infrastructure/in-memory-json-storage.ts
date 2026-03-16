import { JsonFilePort } from '@context/shared/infrastructure/json-storage';

/**
 * In-memory implementation of JsonFilePort for testing.
 */
export class InMemoryJsonFile implements JsonFilePort {
  private data: unknown = null;

  async read<T>(): Promise<T | null> {
    return this.data as T | null;
  }

  async write<T>(data: T): Promise<void> {
    this.data = data;
  }
}

/**
 * Creates StorageFiles for testing with in-memory file ports.
 */
export function createTestStorageFiles() {
  return {
    concepts: new InMemoryJsonFile(),
    studyItems: new InMemoryJsonFile(),
    decks: new InMemoryJsonFile(),
    reviews: new InMemoryJsonFile(),
    syncState: new InMemoryJsonFile(),
  };
}
