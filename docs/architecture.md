# Architecture

Recall is one scheduling authority (the backend) with several clients:

```text
Obsidian plugin ── HTTP ──┐
                          ├── src/server (Node 24) ── SQLite
Android app ───── HTTP ───┘        │
                          src/context (domain kernel)
```

- **`src/context/`** is the portable kernel: domain model, use cases, the Markdown parser and
  the note indexer. It has no Obsidian or Node HTTP dependencies.
- **`src/server/`** is the backend runtime and its composition root. It is the only place
  where FSRS state is computed and stored. See [backend.md](backend.md) for the protocol,
  migration and operational guarantees.
- **`src/app/`** is the Obsidian plugin. It is purely an HTTP client of the backend: it shows
  decks and review queues, sends ratings, and can publish Markdown notes.

Dependencies point inwards: `src/server` → `src/context`, and `src/app` → `src/context`
(types and enums only, e.g. view models, `Rating`, `Direction`). `src/server` never imports
`src/app`, and `src/app` never imports `src/server` nor Node built-ins, so `main.js` only
requires `obsidian`.

## Principles

- **DDD** — aggregates, value objects and repository ports
- **CQRS** — commands change aggregates; queries return read models (`DueStudyItemView`,
  `DeckTreeNode`, `StudyStats`, `LeechView`, `WeakStudyItemView`)
- **Vertical slicing** — each aggregate owns its domain, application and infrastructure code
- **Hexagonal architecture** — the domain defines ports, infrastructure provides adapters
- **ACL (Anti-Corruption Layer)** — the parser and the note indexer translate Markdown into
  domain commands; the domain does not know about Markdown or Obsidian

## Project layout

```
src/
├── context/                         # Portable kernel
│   ├── concept/
│   │   ├── domain/                  # Concept aggregate, Side VO, repository port
│   │   ├── application/             # create, update, remove
│   │   └── infrastructure/          # Markdown + frontmatter parsers
│   ├── study/
│   │   ├── domain/                  # StudyItem aggregate, MemoryState, Rating, Review, ports
│   │   ├── application/             # create, remove, review, correct (amend/remove/restore + replay); due/stats/leech/weak queries
│   │   └── infrastructure/          # FSRS scheduler
│   ├── deck/
│   │   ├── domain/                  # Deck aggregate (hierarchical), repository port
│   │   └── application/             # create, nest, remove, add/remove items; deck tree query
│   ├── indexing/
│   │   ├── domain/source-index.ts   # SourceIndex port (note → cards, lines, items, decks; tag → deck)
│   │   └── application/
│   │       └── note-indexer.ts      # NoteIndexer: note → concepts, study items, tag decks
│   └── shared/
│       ├── domain/                  # Identifier, LLM and TTS client ports
│       └── infrastructure/          # HTTP LLM/TTS adapters; `/sources` wire type re-export
├── server/                          # Backend runtime (Node 24, node:sqlite)
│   ├── main.ts                      # Entry point: env → initial ServerSettings, HTTP server
│   ├── migrate.ts                   # One-shot importer of a legacy recall-data folder
│   ├── http.ts                      # Routes, auth, body limits
│   ├── service.ts                   # RecallService: transactions, receipts, revisions, limits
│   ├── container.ts                 # Composition root, built once (SQLite adapters, use cases, indexer)
│   ├── database.ts                  # SQLite connection, transactions, schema migrations (v1 → v2 → v3 → v4 → v5)
│   ├── legacy-documents.ts          # v2 JSON document shapes: import, export, migration verification
│   ├── persistence/                 # Schema v3 + v4 + v5 and SQLite adapters of the domain ports
│   ├── review-corrections.ts        # Amend/remove/revert reviews: audit trail, daily counters, revisions
│   ├── proposals.ts                 # Card proposals inbox (MCP proposes; the plugin accepts/dismisses)
│   ├── server-settings.ts           # ServerSettings + defaults
│   ├── study-settings.ts            # Stored study settings (meta), validation, tag matching
│   ├── auth.ts, send-json.ts        # HTTP helpers
│   ├── mcp/                         # Optional public listener: MCP tools (read-only; write tools behind RECALL_MCP_WRITE) + single-user OAuth (own SQLite file)
│   └── audio/                       # Optional cloud speech: TTS cache, LLM rewriter, text prep
├── app/                             # Obsidian plugin (backend client only)
│   ├── backend/
│   │   ├── plugin.ts                # Lifecycle, commands, recovery loop, note publishing
│   │   ├── plugin-settings.ts       # data.json shape and tolerant loader
│   │   ├── settings.ts              # Settings tab (backend URL, token, publish notes)
│   │   ├── study-settings-section.ts # "Estudio": tags, limits, shuffle (dry run + confirm)
│   │   ├── study-client.ts          # StudyClient: the port the views depend on
│   │   ├── remote-client.ts         # RemoteClient: StudyClient over HTTP + pending review journal
│   │   ├── remote-note-sync.ts      # Ordered, durable Markdown publication
│   │   ├── proposal-inbox.ts        # Accepted card proposals → inbox notes (one per deck), journaled
│   │   ├── obsidian-inbox-vault.ts  # The plugin's only vault write: create/append inbox notes
│   │   ├── key-debouncer.ts
│   │   └── obsidian-fetch.ts        # fetch over Obsidian's requestUrl (no CORS)
│   └── frontend/
│       ├── deck-browser-view.ts     # Sidebar: decks, totals, leeches
│       ├── review-view.ts           # Review queue
│       └── proposals-view.ts        # Card proposals: accept (writes the card) or dismiss
└── main.ts                          # Plugin entry point

tests/                               # Mirrors src/ (tests/context, tests/server, tests/app)
```

## Server composition

`RecallService` builds one `Container` at startup. Its adapters
(`src/server/persistence/`) implement the domain ports — `ConceptRepository`,
`StudyItemRepository`, `DeckRepository`, `ReviewLog` and the indexer's `SourceIndex` — over
normalized SQLite tables (schema v5) and keep no state between calls; each call reads or
writes only the rows it needs. Every request runs inside `RecallDatabase.transaction()` (a
serialized queue of `BEGIN IMMEDIATE` transactions); adapters throw if used outside one.
Commands commit domain changes, item revisions, daily counters and their idempotency receipt
atomically. `node:sqlite` never appears in `src/context`.

Iteration order is part of the contract (the queue with shuffling off, the deck tree,
`/sources`, leeches): reads follow rowid order and writes use UPSERT, so an updated row keeps
its place and a removed and re-added one goes last, exactly like the keys of the JSON
documents the server stored before v3. The review log is unique per (study item, timestamp)
and read by time, then insertion. Narrow port queries (`countSince`,
`countFirstReviewedSince`, `SourceIndex.locate`, …) keep hot paths off full scans.

`NoteIndexer` depends on an explicit set of ports and use cases, not on the container. It
reads and writes the note index through `SourceIndex` (file → card keys, lines, study items,
leaf decks; tag → deck). Concept, study item and deck IDs are SHA-256 hashes of content and
tags, so the same card keeps its ID and its history across re-indexing and renames.

Edited cards are the exception. Within one sync of one note, `NoteIndexer.inheritEdits` pairs
removed cards with added ones: same directionality and either exactly one side unchanged, or
both sides at least 0.8 similar (`1 − levenshtein / max length` on trimmed, whitespace-collapsed
text, case and accents significant; `indexing/domain/card-similarity.ts` bounds the work with a
length-ratio prefilter, a banded distance, a 1000-code-point side limit and a per-sync cell
budget, and an undecidable comparison blocks instead of pairing). Only one-to-one pairs inherit,
and not when the old concept is shared by another note or the new content already has an
identity. The concept keeps its ID with the new sides; its study items, decks and review log
stay. So IDs are no longer always the hash of the content:

- `SourceIndex` keeps a durable alias, card key → (concept, a→b item, b→a item), for each
  inherited card (table `card_aliases`, schema v4; at most one key per concept, so a later edit
  moves it). A card that is new to a note resolves its IDs as: a live card with the same key
  anywhere (`conceptForCard`), else its alias (a removed edited card comes back with its IDs, and
  `CreateStudyItem` replays its history), else the content hashes.
- Hash IDs are skipped when they belong to other content: a live concept with other sides, or
  another key's alias (typically the pre-edit text). The indexer then salts the hash inputs
  (`#1`, `#2`, …) until the IDs are free, so that text gets fresh, deterministic IDs.
- Aliases are not part of `/sources` or of the legacy documents; a migrated or imported
  database starts with none.
`GET /sources` returns `SourceIndex.snapshot()` in the historical `sync-state` shape.

Study settings are runtime state. `RecallService.settings` returns the stored ones
(`meta.study-settings`) or, while none are stored, the environment's; it mirrors the committed
row (`RecallDatabase.onCommit` updates it only after the writing transaction commits, so a dry
run, which always rolls back, never shows). `NoteIndexer` receives the tag filter as a function
(`allowedTags: () => tags`) and reads it on every sync; while `POST /settings` re-indexes, the
service points it at the new tags inside that transaction. HTTP routes and MCP tools read
`service.settings` per request, so a change needs no restart.

The in-memory doubles used by kernel tests live in `tests/context/fakes/`; a shared contract
suite (`tests/server/persistence/contract.test.ts`) runs the same behaviour tests against them
and the SQLite adapters.

## Plugin

The plugin captures the backend URL and token at load (changes apply after a reload). If
either is missing, it still registers its views, commands and settings tab, and the views
explain that the backend must be configured. Views depend only on `StudyClient`; the backend
applies limits, shuffling and interval previews. Pending reviews and note publications are
journaled in `localStorage` per vault and backend URL, and retried with their original
operation IDs.

The plugin writes to the vault in one case only: when the owner clicks Accept on a card
proposal, it appends the card (`- A :: B` or `- A ::: B`) to `<inbox folder>/<deck>.md`, a note
tagged with that deck (`No deck.md`, untagged, without one), creating it if missing; publication
then turns it into a card. The written card is journaled before the write and the proposal is
accepted after it, so a retry never appends the line twice.

The plugin does not read, write or delete the vault's legacy `recall-data/` folder. Use
`npm run migrate:server` to import it once into a new backend database.

## Data flow

### Write (review)
```
Rating → ReviewView → StudyClient (RemoteClient) → POST /reviews → RecallService
       → ReviewStudyItem → StudyItem aggregate (FSRS) → repository + review log → COMMIT
```

### Correction (review amended or removed)
```
MCP amend_review / remove_review / revert_review_change → ReviewCorrections (audit, counters, revision)
       → CorrectReview → state just before the change (stored `prior`, or replay from scratch
         for pre-v5 reviews, verified against the stored state) → StudyItem.replay of the
         corrected history → review log + repository → COMMIT
```
Each logged review stores the memory state it was applied to (`Review.prior`) and who recorded
it (`Review.origin`: mcp, android, obsidian, api). Review ids (`LoggedReview.id`, the SQLite
`seq`) are never reused, so a removed review can be restored under its id. Card proposals are
not domain objects: they are an inbox table in the server, and only become cards when the
plugin writes them into a note and publishes it.

### Read (query)
```
Deck browser → StudyClient → GET /decks, /stats, /leeches → read projections → rendered
```

### Sync (ACL)
```
Vault file change → plugin → RemoteNoteSync → POST /notes → RecallService
       → NoteIndexer → parser → create/remove concept, study item, deck commands
```

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Algorithm | FSRS via ts-fsrs | Modern, proven (adopted by Anki), better retention than SM-2 |
| Scheduling authority | Single backend | One review history; clients cannot diverge |
| Storage | SQLite (`node:sqlite`), normalized tables behind repository ports | Each operation touches only its rows; cost no longer grows with the history |
| Card data in Markdown | Read-only (ACL parses, never writes scheduling back) | No frontmatter pollution |
| IDs | Content-derived; edited cards keep theirs (aliases) | Reviews survive re-indexing, renames and conservative edits |
| Testing | Vitest | Domain and protocol tested without Obsidian |
