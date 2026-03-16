# Domain Model

## Aggregates

### Concept
Unit of knowledge with two Sides. Can be unidirectional (produces 1 StudyItem) or bidirectional (produces 2 StudyItems).

- **Root entity**: Concept
- **Contains**: Side A (VO), Side B (VO), directionality
- **Invariants**:
  - A Concept always has exactly two Sides
  - A bidirectional Concept always produces 2 StudyItems
  - A unidirectional Concept always produces 1 StudyItem
- **Source**: Discovered by the parser (ACL) from markdown. Commands: `createConcept`, `updateConcept`, `removeConcept`.

### StudyItem
A Concept in a specific direction. The core aggregate for the study domain — receives reviews and manages its own MemoryState.

- **Root entity**: StudyItem
- **Contains**: MemoryState (VO), reference to Concept (by id), direction (which Side is front, which is back)
- **Behavior**: `review(rating)` → recalculates MemoryState via FSRS
- **Invariants**:
  - A StudyItem always has a valid MemoryState
  - A StudyItem always references an existing Concept
- **Derived state**: Leech (calculated from review history — a StudyItem that has been failed repeatedly)

### Deck
Thematic grouping of StudyItems. Hierarchical — a Deck can contain sub-Decks. Studying a Deck includes all StudyItems in its subtree.

- **Root entity**: Deck
- **Contains**: name, reference to parent Deck (nullable), references to StudyItems (by id)
- **Invariants**:
  - A Deck's hierarchy must be acyclic (no circular parent references)
  - A StudyItem can belong to one or more Decks
- **Source**: Discovered by the parser (ACL) from tags. Commands: `createDeck`, `nestDeck`, `removeDeck`.

### Session
A block of study time scoped to a Deck. Contains the sequence of Reviews performed.

- **Root entity**: Session
- **Contains**: list of Reviews (VO), reference to Deck (by id), start/end timestamps
- **Behavior**: `addReview(studyItemId, rating)` → records the review
- **Invariants**:
  - A Session is always scoped to a Deck
  - Reviews within a Session are ordered chronologically

## Value Objects

### Side
The content of one face of a Concept. Immutable.

### MemoryState
The FSRS state for a StudyItem: stability, difficulty, due date, reps, lapses. Replaced entirely after each review.

### Review
A record of a single review: StudyItem reference, Rating, timestamp. Immutable.

### Rating
Self-evaluation after a review. Enum: Again, Hard, Good, Easy.

## Integration

### Parser as Anti-Corruption Layer (ACL)
The parser reads markdown files and translates them into domain commands:
- Markdown card definitions → `createConcept` / `updateConcept` / `removeConcept`
- Tags → `createDeck` / `nestDeck` / `removeDeck`
- StudyItems are created/removed as a consequence of Concept creation (bidirectional → 2, unidirectional → 1)

This separation means the domain does not depend on markdown or Obsidian. If the source changes (standalone app, web UI), only the ACL changes — the domain stays intact.

## CQRS

### Write side (Commands)
- `review(studyItemId, rating)` — loads StudyItem, applies FSRS, persists new MemoryState
- `createConcept`, `updateConcept`, `removeConcept` — from parser
- `createDeck`, `nestDeck`, `removeDeck` — from parser
- `startSession(deckId)`, `addReview(sessionId, studyItemId, rating)`, `endSession(sessionId)`

### Read side (Queries / Projections)
- Next card to study → optimized read model
- Deck browser with due counts → projection
- Stats (retention rate, time per card, trends) → projection over review history
- Leech detection → projection over StudyItem review history
- Session summary → projection over session data

Read models are independent from aggregates. They can denormalize, precompute, and compose data freely.
