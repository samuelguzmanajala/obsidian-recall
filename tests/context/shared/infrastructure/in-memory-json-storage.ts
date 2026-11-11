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
