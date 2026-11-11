import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JsonFileStorage } from '../context/shared/infrastructure/json-storage';

/** Receipt key for a command: sha256 hex of its canonical JSON (shared by `once()` and the v1→v2 migration). */
export function payloadHash(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}

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
    if (version > 2) { this.sql.close(); throw new Error('Database schema is newer than this server; refusing to downgrade'); }
    this.sql.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
    `);
    if (version === 1) {
      try { this.migrateV1(); } catch (error) { this.sql.close(); throw error; }
      try { this.sql.exec('VACUUM'); } catch (error) { console.error('VACUUM after schema migration failed (non-fatal):', error); }
    }
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notes (path TEXT PRIMARY KEY, content TEXT, revision INTEGER NOT NULL);
      PRAGMA user_version=2;
    `);
  }
  /** v1 kept full command payloads (whole notes) forever; v2 keeps only their hash. All or nothing. */
  private migrateV1() {
    const now = Date.now();
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      this.sql.exec('CREATE TABLE operations_v2 (id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL)');
      const insert = this.sql.prepare('INSERT INTO operations_v2 VALUES (?,?,?,?)');
      for (const row of this.sql.prepare('SELECT id,payload,result FROM operations').iterate()) {
        insert.run(row.id as string, payloadHash(row.payload as string), row.result as string, now);
      }
      this.sql.exec('DROP TABLE operations; ALTER TABLE operations_v2 RENAME TO operations; PRAGMA user_version=2; COMMIT');
    } catch (error) {
      if (this.sql.isTransaction) this.sql.exec('ROLLBACK');
      throw error;
    }
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
