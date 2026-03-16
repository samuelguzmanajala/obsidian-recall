# Ubiquitous Language

## Core Concepts

### Concept
Something you want to learn. It has two **Sides**. It can be studied in one direction (unidirectional) or both (bidirectional).

### Side
Each face of a Concept. It is neither "question" nor "answer" until it is presented in a specific direction during study.

### StudyItem
A Concept in a specific direction. It is what appears when you study: you see one Side and try to recall the other. A unidirectional Concept produces 1 StudyItem. A bidirectional Concept produces 2 StudyItems, each with its own independent MemoryState.

### Deck
A thematic grouping of StudyItems. Hierarchical — a Deck can contain sub-Decks. Studying a Deck includes all StudyItems in its entire subtree. A StudyItem can belong to one or more Decks.

### MemoryState
The state of your memory for a specific StudyItem. How well you remember it, when you should review it next. Managed by the FSRS algorithm.

### Review
The moment you face a StudyItem, try to recall, and evaluate how it went. A Review produces a Rating and updates the StudyItem's MemoryState.

### Rating
Your self-evaluation after a Review. Four levels: Again, Hard, Good, Easy.

### Session
A block of time where you do multiple Reviews in sequence. Scoped to a Deck.

### Leech
A StudyItem that you fail repeatedly and cannot retain. Detected automatically based on review history.
