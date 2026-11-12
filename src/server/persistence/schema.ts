/**
 * Schema v3. Tables whose iteration order is observable (concepts, study items, decks and their
 * items, note files and their entries, tags) are read in rowid order and written with UPSERT,
 * which keeps a row's rowid; a deleted and re-added row goes to the end, like a JSON object key.
 * There are no foreign keys: dangling references from older data are kept as they are.
 */
export const SCHEMA_V3 = `
  CREATE TABLE concepts (id TEXT PRIMARY KEY, side_a TEXT NOT NULL, side_b TEXT NOT NULL, directionality TEXT NOT NULL);
  CREATE TABLE study_items (id TEXT PRIMARY KEY, concept_id TEXT NOT NULL, direction TEXT NOT NULL,
    stability REAL NOT NULL, difficulty REAL NOT NULL, due INTEGER NOT NULL, reps INTEGER NOT NULL,
    lapses INTEGER NOT NULL, last_review INTEGER);
  CREATE INDEX study_items_due ON study_items(due);
  CREATE INDEX study_items_concept ON study_items(concept_id);
  CREATE TABLE item_revisions (study_item_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
  CREATE TABLE decks (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT);
  CREATE INDEX decks_parent ON decks(parent_id);
  CREATE TABLE deck_items (deck_id TEXT NOT NULL, study_item_id TEXT NOT NULL, UNIQUE (deck_id, study_item_id));
  CREATE TABLE reviews (seq INTEGER PRIMARY KEY, study_item_id TEXT NOT NULL, rating TEXT NOT NULL,
    timestamp INTEGER NOT NULL, UNIQUE (study_item_id, timestamp));
  CREATE INDEX reviews_timestamp ON reviews(timestamp);
  CREATE TABLE note_files (path TEXT PRIMARY KEY);
  CREATE TABLE note_cards (path TEXT NOT NULL, card_key TEXT NOT NULL, concept_id TEXT NOT NULL, UNIQUE (path, card_key));
  CREATE INDEX note_cards_concept ON note_cards(concept_id);
  CREATE TABLE note_lines (path TEXT NOT NULL, concept_id TEXT NOT NULL, line INTEGER NOT NULL, UNIQUE (path, concept_id));
  CREATE TABLE note_items (path TEXT NOT NULL, study_item_id TEXT NOT NULL);
  CREATE INDEX note_items_path ON note_items(path);
  CREATE TABLE note_decks (path TEXT NOT NULL, deck_id TEXT NOT NULL);
  CREATE INDEX note_decks_path ON note_decks(path);
  CREATE TABLE tag_decks (tag TEXT PRIMARY KEY, deck_id TEXT NOT NULL);
  CREATE TABLE daily_budgets (day_start INTEGER PRIMARY KEY, introduced INTEGER NOT NULL, reviewed INTEGER NOT NULL);
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/**
 * Schema v4 (additive): durable card key → inherited IDs of an edited card (at most one key per
 * concept), and a lookup of live cards by key.
 */
export const SCHEMA_V4 = `
  CREATE TABLE card_aliases (card_key TEXT PRIMARY KEY, concept_id TEXT NOT NULL UNIQUE, a_to_b TEXT NOT NULL, b_to_a TEXT);
  CREATE INDEX card_aliases_a_to_b ON card_aliases(a_to_b);
  CREATE INDEX card_aliases_b_to_a ON card_aliases(b_to_a);
  CREATE INDEX note_cards_key ON note_cards(card_key);
`;

/**
 * Schema v5. The review log is rebuilt (same rows, same `seq`) with an AUTOINCREMENT key, so a
 * removed review's id is never given to another one (corrections refer to reviews by id and can
 * restore a removed one under its id), plus two nullable columns: `origin` (who recorded it:
 * mcp, android, obsidian, api) and `prior` (JSON memory state the review was applied to). Older
 * rows keep both NULL. New tables: `review_changes`, the audit trail of corrections (amend, remove,
 * restore; enough to revert each), and `card_proposals`, cards suggested over MCP waiting for the
 * owner's decision in Obsidian (they never become cards by themselves).
 */
export const SCHEMA_V5 = `
  CREATE TABLE reviews_v5 (seq INTEGER PRIMARY KEY AUTOINCREMENT, study_item_id TEXT NOT NULL, rating TEXT NOT NULL,
    timestamp INTEGER NOT NULL, origin TEXT, prior TEXT, UNIQUE (study_item_id, timestamp));
  INSERT INTO reviews_v5 (seq, study_item_id, rating, timestamp) SELECT seq, study_item_id, rating, timestamp FROM reviews ORDER BY seq;
  DROP TABLE reviews;
  ALTER TABLE reviews_v5 RENAME TO reviews;
  CREATE INDEX reviews_timestamp ON reviews(timestamp);
  CREATE TABLE review_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, review_id INTEGER NOT NULL, study_item_id TEXT NOT NULL,
    review_timestamp INTEGER NOT NULL, review_origin TEXT, action TEXT NOT NULL, old_rating TEXT, new_rating TEXT, prior TEXT,
    reverts INTEGER, at INTEGER NOT NULL, origin TEXT NOT NULL);
  CREATE INDEX review_changes_review ON review_changes(review_id);
  CREATE INDEX review_changes_at ON review_changes(at);
  CREATE TABLE card_proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, side_a TEXT NOT NULL, side_b TEXT NOT NULL,
    directionality TEXT NOT NULL, deck TEXT, context TEXT, status TEXT NOT NULL, origin TEXT NOT NULL,
    created_at INTEGER NOT NULL, decided_at INTEGER, note_path TEXT);
  CREATE INDEX card_proposals_status ON card_proposals(status);
`;

/** Tables that hold study data (everything except receipts and notes). */
export const DATA_TABLES = ['concepts', 'study_items', 'item_revisions', 'decks', 'deck_items', 'reviews', 'note_files',
  'note_cards', 'note_lines', 'note_items', 'note_decks', 'tag_decks', 'daily_budgets', 'meta', 'card_aliases', 'review_changes', 'card_proposals'] as const;
