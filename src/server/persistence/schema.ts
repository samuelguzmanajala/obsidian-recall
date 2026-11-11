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

/** Tables that hold study data (everything except receipts and notes). */
export const DATA_TABLES = ['concepts', 'study_items', 'item_revisions', 'decks', 'deck_items', 'reviews', 'note_files',
  'note_cards', 'note_lines', 'note_items', 'note_decks', 'tag_decks', 'daily_budgets', 'meta', 'card_aliases'] as const;
