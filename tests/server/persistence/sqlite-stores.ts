import { RecallDatabase } from '../../../src/server/database';
import { SqliteConceptRepository, SqliteDeckRepository, SqliteReviewLog, SqliteStudyItemRepository } from '../../../src/server/persistence/sqlite-repositories';
import { SqliteSourceIndex } from '../../../src/server/persistence/sqlite-source-index';
import type { Stores } from '../../context/fakes/in-memory';

/** SQLite adapters on `:memory:`, inside one open transaction (call `close()` when done). */
export function sqliteStores(): Stores & { db: RecallDatabase; close(): Promise<void> } {
  const db = new RecallDatabase(':memory:');
  db.sql.exec('BEGIN');
  return {
    db, concepts: new SqliteConceptRepository(db), studyItems: new SqliteStudyItemRepository(db),
    decks: new SqliteDeckRepository(db), reviews: new SqliteReviewLog(db), sources: new SqliteSourceIndex(db),
    close: async () => { db.sql.exec('ROLLBACK'); await db.close(); },
  };
}
