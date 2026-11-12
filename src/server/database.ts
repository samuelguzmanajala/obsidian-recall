import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA_V3, SCHEMA_V4, SCHEMA_V5 } from './persistence/schema';
import { exportDocuments, importDocuments, verifyDocuments } from './legacy-documents';

/** Receipt key for a command: sha256 hex of its canonical JSON (shared by `once()` and the v1→v2 migration). */
export function payloadHash(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}

const BASE_TABLES = `
  CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS notes (path TEXT PRIMARY KEY, content TEXT, revision INTEGER NOT NULL);
`;

export const SCHEMA_VERSION = 5;

/** One connection, serialized transactions, durable commits. No network awaits inside transactions. */
export class RecallDatabase {
  readonly sql: DatabaseSync;
  private tail: Promise<unknown> = Promise.resolve();
  private statements = new Map<string, StatementSync>();
  private readonly readOnly: boolean;
  /**
   * `readOnly`: for tools that run next to a live server. Never writes, never migrates, never changes
   * the journal mode; refuses any schema version other than the current one. Transactions are plain
   * (deferred) read transactions, so they never take the write lock.
   */
  constructor(path: string, options: { readOnly?: boolean } = {}) {
    this.readOnly = options.readOnly === true;
    if (this.readOnly) {
      this.sql = new DatabaseSync(path, { readOnly: true });
      const found = Number(this.sql.prepare('PRAGMA user_version').get()?.user_version ?? 0);
      if (found !== SCHEMA_VERSION) {
        this.sql.close();
        throw new Error(`Database schema version is ${found}, this build expects ${SCHEMA_VERSION}. `
          + 'Start (or update) the server once so it migrates the database; this tool never migrates.');
      }
      this.sql.exec('PRAGMA query_only=1; PRAGMA busy_timeout=5000;');
      return;
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.sql = new DatabaseSync(path);
    const version = Number(this.sql.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version > SCHEMA_VERSION) { this.sql.close(); throw new Error('Database schema is newer than this server; refusing to downgrade'); }
    this.sql.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
    `);
    try {
      if (version === 1) this.migrateV1();
      if (version === 1 || version === 2) this.migrateV2();
      if (version >= 1 && version <= 3) this.migrateV3();
      if (version >= 1 && version <= 4) this.migrateV4();
    } catch (error) { this.sql.close(); throw error; }
    if (version === 1 || version === 2) {
      try { this.sql.exec('VACUUM'); } catch (error) { console.error('VACUUM after schema migration failed (non-fatal):', error); }
    }
    if (version === 0) this.sql.exec(`BEGIN; ${BASE_TABLES} ${SCHEMA_V3} ${SCHEMA_V4} ${SCHEMA_V5} PRAGMA user_version=5; COMMIT;`);
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
  /**
   * v2 kept every aggregate collection as one JSON document; v3 normalizes them into tables.
   * Before dropping the documents, the tables are exported back and compared with them. All or nothing.
   */
  private migrateV2() {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT NOT NULL); ${BASE_TABLES} ${SCHEMA_V3}`);
      const documents: Record<string, unknown> = Object.create(null);
      for (const row of this.sql.prepare('SELECT key,value FROM documents').iterate()) documents[row.key as string] = JSON.parse(row.value as string);
      importDocuments(this.sql, documents);
      verifyDocuments(documents, exportDocuments(this.sql));
      this.sql.exec('DROP TABLE documents; PRAGMA user_version=3; COMMIT');
    } catch (error) {
      if (this.sql.isTransaction) this.sql.exec('ROLLBACK');
      throw error;
    }
  }
  /** v4 adds card aliases (inherited IDs of edited cards); existing data has none. All or nothing. */
  private migrateV3() {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      this.sql.exec(`${SCHEMA_V4} PRAGMA user_version=4; COMMIT`);
    } catch (error) {
      if (this.sql.isTransaction) this.sql.exec('ROLLBACK');
      throw error;
    }
  }
  /**
   * v5 rebuilds the review log with an AUTOINCREMENT key and the nullable origin/prior columns (the
   * rows, their `seq` and order are checked to be identical before committing), and adds the
   * correction audit trail and card proposals. All or nothing: on failure the database stays v4.
   */
  private migrateV4() {
    const rows = () => this.sql.prepare('SELECT seq, study_item_id, rating, timestamp FROM reviews ORDER BY seq').all();
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const before = payloadHash(JSON.stringify(rows()));
      this.sql.exec(SCHEMA_V5);
      if (payloadHash(JSON.stringify(rows())) !== before) throw new Error('Schema v5 migration verification failed: reviews differ');
      this.sql.exec('PRAGMA user_version=5; COMMIT');
    } catch (error) {
      if (this.sql.isTransaction) this.sql.exec('ROLLBACK');
      throw error;
    }
  }
  /** Cached prepared statement for storage access; only inside `transaction()`. */
  stmt(source: string): StatementSync {
    if (!this.sql.isTransaction) throw new Error('Storage access requires a transaction');
    let statement = this.statements.get(source);
    if (!statement) this.statements.set(source, statement = this.sql.prepare(source));
    return statement;
  }
  transaction<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      this.sql.exec(this.readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
      try {
        const value = await work();
        this.sql.exec('COMMIT');
        return value;
      } catch (error) {
        this.sql.exec('ROLLBACK');
        throw error;
      }
    });
    this.tail = result.catch(() => {});
    return result;
  }
  async close(): Promise<void> { await this.tail; this.sql.close(); }
}
