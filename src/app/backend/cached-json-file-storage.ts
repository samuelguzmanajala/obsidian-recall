import { JsonFileStorage } from '@context/shared/infrastructure/json-storage';

/**
 * Decorator over JsonFileStorage that adds in-memory caching and batch mode.
 * The repos don't know about this — they just call read/write on JsonFileStorage.
 *
 * The plugin controls batch mode and cache invalidation directly on this class.
 */
export class CachedJsonFileStorage implements JsonFileStorage {
  private cache: unknown | null = null;
  private dirty = false;
  private batchMode = false;

  constructor(private readonly inner: JsonFileStorage) {}

  async read<T>(): Promise<T | null> {
    if (this.cache !== null) return this.cache as T;
    const data = await this.inner.read<T>();
    this.cache = data;
    return data;
  }

  async write<T>(data: T): Promise<void> {
    this.cache = data;
    if (this.batchMode) {
      this.dirty = true;
      return;
    }
    await this.inner.write(data);
  }

  // --- Methods for plugin/infra use only (NOT part of JsonFileStorage) ---

  setBatchMode(on: boolean): void {
    this.batchMode = on;
  }

  async flush(): Promise<void> {
    this.batchMode = false;
    if (this.dirty && this.cache !== null) {
      await this.inner.write(this.cache);
      this.dirty = false;
    }
  }

  invalidate(): void {
    this.cache = null;
    this.dirty = false;
  }

  async clear(): Promise<void> {
    this.cache = null;
    this.dirty = false;
    await this.inner.write({});
  }
}
