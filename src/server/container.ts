// Domain ports
import { ConceptRepository } from '@context/concept/domain/concept-repository';
import { StudyItemRepository } from '@context/study/domain/study-item-repository';
import { DeckRepository } from '@context/deck/domain/deck-repository';
import { ReviewLog } from '@context/study/domain/review-log';
import { SourceIndex } from '@context/indexing/domain/source-index';

// Infrastructure implementations
import type { RecallDatabase } from './database';
import { SqliteConceptRepository, SqliteDeckRepository, SqliteReviewLog, SqliteStudyItemRepository } from './persistence/sqlite-repositories';
import { SqliteSourceIndex } from './persistence/sqlite-source-index';

// Infrastructure
import { FsrsScheduler } from '@context/study/infrastructure/fsrs-scheduler';
import { MarkdownParser } from '@context/concept/infrastructure/markdown-parser';

// Use cases — Concept
import { CreateConcept } from '@context/concept/application/create-concept';
import { UpdateConcept } from '@context/concept/application/update-concept';
import { RemoveConcept } from '@context/concept/application/remove-concept';

// Use cases — Study
import { CreateStudyItem } from '@context/study/application/create-study-item';
import { RemoveStudyItem } from '@context/study/application/remove-study-item';
import { ReviewStudyItem } from '@context/study/application/review-study-item';

// Use cases — Deck
import { CreateDeck } from '@context/deck/application/create-deck';
import { NestDeck } from '@context/deck/application/nest-deck';
import { RemoveDeck } from '@context/deck/application/remove-deck';
import { AddStudyItemToDeck } from '@context/deck/application/add-study-item-to-deck';
import { RemoveStudyItemFromDeck } from '@context/deck/application/remove-study-item-from-deck';

// Queries
import { GetDueStudyItems } from '@context/study/application/get-due-study-items';
import { GetDeckTree } from '@context/deck/application/get-deck-tree';
import { GetStudyStats } from '@context/study/application/get-study-stats';
import { GetLeeches } from '@context/study/application/get-leeches';

// Indexing
import { NoteIndexer } from '@context/indexing/application/note-indexer';

/**
 * Server composition root, built once per service. Every adapter reads and writes SQLite rows
 * and throws outside `RecallDatabase.transaction()`, so state is never cached between requests.
 */
export class Container {
  // Domain ports — the ONLY way to access data from use cases and frontend
  readonly conceptRepository: ConceptRepository;
  readonly studyItemRepository: StudyItemRepository;
  readonly deckRepository: DeckRepository;
  readonly reviewLog: ReviewLog;

  readonly sources: SourceIndex;

  // Infrastructure
  readonly scheduler: FsrsScheduler;
  readonly parser: MarkdownParser;

  // Use cases — Concept
  readonly createConcept: CreateConcept;
  readonly updateConcept: UpdateConcept;
  readonly removeConcept: RemoveConcept;

  // Use cases — Study
  readonly createStudyItem: CreateStudyItem;
  readonly removeStudyItem: RemoveStudyItem;
  readonly reviewStudyItem: ReviewStudyItem;

  // Use cases — Deck
  readonly createDeck: CreateDeck;
  readonly nestDeck: NestDeck;
  readonly removeDeck: RemoveDeck;
  readonly addStudyItemToDeck: AddStudyItemToDeck;
  readonly removeStudyItemFromDeck: RemoveStudyItemFromDeck;

  // Queries
  readonly getDueStudyItems: GetDueStudyItems;
  readonly getDeckTree: GetDeckTree;
  readonly getStudyStats: GetStudyStats;
  readonly getLeeches: GetLeeches;

  // Markdown → domain commands
  readonly indexer: NoteIndexer;

  /** `flashcardTags`: tags to index (empty = all). */
  constructor(db: RecallDatabase, flashcardTags: string[] = []) {
    // Infrastructure
    this.scheduler = new FsrsScheduler();
    this.parser = new MarkdownParser();

    // Repositories — plain implementations, no cache logic
    this.conceptRepository = new SqliteConceptRepository(db);
    this.studyItemRepository = new SqliteStudyItemRepository(db);
    this.deckRepository = new SqliteDeckRepository(db);
    this.reviewLog = new SqliteReviewLog(db);
    this.sources = new SqliteSourceIndex(db);

    // Use cases
    this.createConcept = new CreateConcept(this.conceptRepository);
    this.updateConcept = new UpdateConcept(this.conceptRepository);
    this.removeConcept = new RemoveConcept(this.conceptRepository);

    this.createStudyItem = new CreateStudyItem(
      this.studyItemRepository,
      this.reviewLog,
      this.scheduler,
    );
    this.removeStudyItem = new RemoveStudyItem(this.studyItemRepository);
    this.reviewStudyItem = new ReviewStudyItem(
      this.studyItemRepository,
      this.scheduler,
      this.reviewLog,
    );

    this.createDeck = new CreateDeck(this.deckRepository);
    this.nestDeck = new NestDeck(this.deckRepository);
    this.removeDeck = new RemoveDeck(this.deckRepository);
    this.addStudyItemToDeck = new AddStudyItemToDeck(this.deckRepository);
    this.removeStudyItemFromDeck = new RemoveStudyItemFromDeck(this.deckRepository);

    // Queries
    this.getDueStudyItems = new GetDueStudyItems(
      this.studyItemRepository,
      this.conceptRepository,
      this.deckRepository,
      this.reviewLog,
      this.scheduler,
    );
    this.getDeckTree = new GetDeckTree(this.deckRepository, this.studyItemRepository);
    this.getStudyStats = new GetStudyStats(this.studyItemRepository, this.reviewLog);
    this.getLeeches = new GetLeeches(this.studyItemRepository, this.conceptRepository);

    this.indexer = new NoteIndexer({
      parser: this.parser,
      sources: this.sources,
      studyItemRepository: this.studyItemRepository,
      deckRepository: this.deckRepository,
      createConcept: this.createConcept,
      removeConcept: this.removeConcept,
      createStudyItem: this.createStudyItem,
      removeStudyItem: this.removeStudyItem,
      createDeck: this.createDeck,
      nestDeck: this.nestDeck,
      addStudyItemToDeck: this.addStudyItemToDeck,
      removeStudyItemFromDeck: this.removeStudyItemFromDeck,
      allowedTags: flashcardTags,
    });
  }
}
