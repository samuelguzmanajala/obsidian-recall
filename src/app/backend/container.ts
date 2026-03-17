import { JsonFilePort } from '@context/shared/infrastructure/json-storage';

// Repositories
import { JsonConceptRepository } from '@context/concept/infrastructure/json-concept-repository';
import { JsonStudyItemRepository } from '@context/study/infrastructure/json-study-item-repository';
import { JsonDeckRepository } from '@context/deck/infrastructure/json-deck-repository';
import { JsonReviewLog } from '@context/study/infrastructure/json-review-log';

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
import { GetDueStudyItemsByDeck } from '@context/study/application/get-due-study-items-by-deck';
import { GetDeckTree } from '@context/deck/application/get-deck-tree';
import { GetStudyStats } from '@context/study/application/get-study-stats';
import { GetLeeches } from '@context/study/application/get-leeches';
import { ImportSrData } from '@context/study/application/import-sr-data';
import { ReplayReviews } from '@context/study/application/replay-reviews';
import { RecallSettings } from './settings';
import type { VaultSync } from './vault-sync';
import { LlmClient } from '@context/shared/domain/llm-client';
import { HttpLlmClient } from '@context/shared/infrastructure/llm-adapters';

export interface StorageFiles {
  concepts: JsonFilePort;
  studyItems: JsonFilePort;
  decks: JsonFilePort;
  reviews: JsonFilePort;
  syncState: JsonFilePort;
}

export class Container {
  // Repositories
  readonly conceptRepository: JsonConceptRepository;
  readonly studyItemRepository: JsonStudyItemRepository;
  readonly deckRepository: JsonDeckRepository;
  readonly reviewLog: JsonReviewLog;

  // Storage
  readonly syncStateFile: JsonFilePort;

  // Settings (mutable — updated by plugin on save)
  settings: RecallSettings | null = null;

  // Callback to persist settings without triggering full reset
  saveSettingsQuiet: (() => Promise<void>) | null = null;

  // VaultSync reference (set by plugin after construction)
  vaultSync: VaultSync | null = null;

  // LLM client (reads provider/key from settings dynamically)
  readonly llmClient: LlmClient;

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
  readonly getDueStudyItemsByDeck: GetDueStudyItemsByDeck;
  readonly getDeckTree: GetDeckTree;
  readonly getStudyStats: GetStudyStats;
  readonly getLeeches: GetLeeches;
  readonly importSrData: ImportSrData;
  readonly replayReviews: ReplayReviews;

  constructor(files: StorageFiles) {
    // Infrastructure
    this.scheduler = new FsrsScheduler();
    this.parser = new MarkdownParser();
    this.syncStateFile = files.syncState;

    // Repositories — each with its own file
    this.conceptRepository = new JsonConceptRepository(files.concepts);
    this.studyItemRepository = new JsonStudyItemRepository(files.studyItems);
    this.deckRepository = new JsonDeckRepository(files.decks);
    this.reviewLog = new JsonReviewLog(files.reviews);

    // Use cases
    this.createConcept = new CreateConcept(this.conceptRepository);
    this.updateConcept = new UpdateConcept(this.conceptRepository);
    this.removeConcept = new RemoveConcept(this.conceptRepository);

    this.createStudyItem = new CreateStudyItem(this.studyItemRepository);
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
    this.getDueStudyItems = new GetDueStudyItems(this.studyItemRepository, this.conceptRepository);
    this.getDueStudyItemsByDeck = new GetDueStudyItemsByDeck(
      this.studyItemRepository,
      this.conceptRepository,
      this.deckRepository,
    );
    this.getDeckTree = new GetDeckTree(this.deckRepository, this.studyItemRepository);
    this.getStudyStats = new GetStudyStats(this.studyItemRepository, this.reviewLog);
    this.getLeeches = new GetLeeches(this.studyItemRepository, this.conceptRepository);
    this.importSrData = new ImportSrData(this.studyItemRepository);
    this.replayReviews = new ReplayReviews(this.studyItemRepository, this.reviewLog, this.scheduler);

    // LLM — reads from settings lazily so it always uses current config
    this.llmClient = new HttpLlmClient(
      () => this.settings?.llmProvider ?? 'none',
      () => this.settings?.llmApiKey ?? '',
    );
  }
}
