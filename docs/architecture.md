# Architecture

## Principles

- **DDD** — Domain-Driven Design with aggregates, value objects, and ports
- **CQRS** — Command and Query Responsibility Segregation. Write side (aggregates) and read side (projections) are separate
- **Vertical Slicing** — each aggregate owns its domain, application, and infrastructure layers
- **Hexagonal Architecture** — domain defines ports (interfaces), infrastructure provides adapters
- **ACL (Anti-Corruption Layer)** — the parser translates markdown into domain commands. The domain does not know about Obsidian or markdown

## Project Layout

```
obsidian-recall/
├── context/                              # Bounded context — portable, no Obsidian dependency
│   └── src/
│       ├── concept/
│       │   ├── domain/                   # Aggregate root, Side VO, repository port
│       │   ├── application/              # Use cases: create, update, remove
│       │   └── infrastructure/           # Markdown parser (ACL adapter)
│       ├── study/
│       │   ├── domain/                   # StudyItem aggregate, MemoryState VO, Rating VO
│       │   ├── application/              # Use case: review
│       │   └── infrastructure/           # FSRS scheduler adapter
│       ├── deck/
│       │   ├── domain/                   # Deck aggregate (hierarchical), repository port
│       │   ├── application/              # Use cases: create, nest, remove
│       │   └── infrastructure/           # Tag-based deck resolver
│       ├── session/
│       │   ├── domain/                   # Session aggregate, Review VO
│       │   ├── application/              # Use cases: start, add review, end
│       │   └── infrastructure/
│       └── shared/
│           └── domain/                   # Shared VOs if needed
├── app/                                  # Obsidian-specific wiring
│   ├── backend/
│   │   └── src/
│   │       ├── plugin.ts                 # Obsidian plugin lifecycle
│   │       ├── container.ts              # Dependency injection / wiring
│   │       └── vault-sync.ts             # Vault change listener → domain commands
│   └── frontend/
│       └── src/
│           ├── review-modal.ts           # Review UI
│           ├── deck-browser.ts           # Deck navigation
│           ├── stats-view.ts             # Statistics panel
│           └── settings-tab.ts           # Plugin settings
├── main.ts                               # Entry point
├── docs/                                 # Project documentation
│   ├── ubiquitous-language.md
│   ├── domain-model.md
│   └── architecture.md (this file)
└── tests/                                # Mirror structure of context/
```

## Separation of Concerns

### context/
The bounded context. Pure domain logic + application services + infrastructure adapters per aggregate. **Does not depend on Obsidian.** Portable — if the project becomes a standalone app, this module moves as-is.

### app/backend/
Obsidian-specific orchestration. Wires the context to the Obsidian plugin lifecycle:
- Listens to vault changes and triggers domain commands
- Manages dependency injection
- Handles plugin load/unload

### app/frontend/
UI layer. Consumes read models from the context. Does not call aggregates directly — goes through application services or read projections.

## Data Flow

### Write (Command)
```
User clicks "Good" → frontend → application service (review-study-item) → StudyItem aggregate → FSRS recalculates MemoryState → persisted via repository port
```

### Read (Query)
```
User opens deck browser → frontend → read projection (due counts per deck) → rendered
```

### Sync (ACL)
```
Vault file changes → vault-sync (backend) → parser (ACL) → createConcept / updateConcept / removeConcept commands → domain
```

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Algorithm | FSRS via ts-fsrs | Modern, proven (adopted by Anki), better retention than SM-2 |
| Storage | Behind port/interface | Concrete adapter TBD — keeps domain portable |
| Card data in markdown | Read-only (ACL parses, never writes scheduling back) | No frontmatter pollution |
| Scheduling data | Separate from markdown files | Plugin owns scheduling, vault owns content |
| Testing | Vitest from day 1 | Domain logic must be tested independently |
