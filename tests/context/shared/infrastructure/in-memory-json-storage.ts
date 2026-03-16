import { JsonStoragePort, StorageData, emptyStorageData } from '@context/shared/infrastructure/json-storage';

export class InMemoryJsonStorage implements JsonStoragePort {
  private data: StorageData = emptyStorageData();

  async load(): Promise<StorageData> {
    return this.data;
  }

  async save(data: StorageData): Promise<void> {
    this.data = data;
  }
}
