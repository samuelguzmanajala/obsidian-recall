import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JsonFileStorage } from '../context/shared/infrastructure/json-storage';

/** One connection, serialized transactions, durable commits. No network awaits inside transactions. */
export class RecallDatabase {
  readonly sql: DatabaseSync;
  private tail: Promise<unknown> = Promise.resolve();
  private cache = new Map<string, unknown>();
  private dirty = new Set<string>();
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.sql = new DatabaseSync(path);
    const version = Number(this.sql.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version > 1) { this.sql.close(); throw new Error('Database schema is newer than this server; refusing to downgrade'); }
    this.sql.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, payload TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notes (path TEXT PRIMARY KEY, content TEXT, revision INTEGER NOT NULL);
      PRAGMA user_version=1;
    `);
  }
  document(key: string): JsonFileStorage {
    return {
      read: async <T>() => {
        if (!this.sql.isTransaction) throw new Error('Document access requires a transaction');
        if (this.cache.has(key)) return this.cache.get(key) as T | null;
        const row = this.sql.prepare('SELECT value FROM documents WHERE key=?').get(key);
        const value = row ? JSON.parse(row.value as string) as T : null;
        this.cache.set(key, value);
        return value;
      },
      write: async <T>(value: T) => {
        if (!this.sql.isTransaction) throw new Error('Document access requires a transaction');
        this.cache.set(key, value);
        this.dirty.add(key);
      },
    };
  }
  transaction<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      this.sql.exec('BEGIN IMMEDIATE');
      this.cache.clear();
      this.dirty.clear();
      try {
        const value = await work();
        for (const key of this.dirty) {
          this.sql.prepare('INSERT INTO documents VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
            .run(key, JSON.stringify(this.cache.get(key)));
        }
        this.sql.exec('COMMIT');
        return value;
      } catch (error) {
        this.sql.exec('ROLLBACK');
        throw error;
      } finally {
        this.cache.clear();
        this.dirty.clear();
      }
    });
    this.tail = result.catch(() => {});
    return result;
  }
  async close(): Promise<void> { await this.tail; this.sql.close(); }
}
