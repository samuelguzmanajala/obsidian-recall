import { JsonFileStorage } from '@context/shared/infrastructure/json-storage';

// Domain ports
import { ConceptRepository } from '@context/concept/domain/concept-repository';
import { StudyItemRepository } from '@context/study/domain/study-item-repository';
import { DeckRepository } from '@context/deck/domain/deck-repository';
import { ReviewLog } from '@context/study/domain/review-log';

// Infrastructure implementations
import { JsonConceptRepository } from '@context/concept/infrastructure/json-concept-repository';
import { JsonStudyItemRepository } from '@context/study/infrastructure/json-study-item-repository';
import { JsonDeckRepository } from '@context/deck/infrastructure/json-deck-repository';

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
import type { RecallSettings } from './recall-settings';
import type { VaultSync } from './vault-sync';
import { LlmClient } from '@context/shared/domain/llm-client';
import { HttpLlmClient } from '@context/shared/infrastructure/llm-adapters';
import { TtsClient } from '@context/shared/domain/tts-client';
import { OpenAiTtsClient } from '@context/shared/infrastructure/openai-tts-client';

export interface StorageFiles {
  concepts: JsonFileStorage;
  studyItems: JsonFileStorage;
  decks: JsonFileStorage;
  reviewLog: ReviewLog;
  syncState: JsonFileStorage;
}

export class Container {
  // Domain ports — the ONLY way to access data from use cases and frontend
  readonly conceptRepository: ConceptRepository;
  readonly studyItemRepository: StudyItemRepository;
  readonly deckRepository: DeckRepository;
  readonly reviewLog: ReviewLog;

  // Storage
  readonly syncStateFile: JsonFileStorage;

  // Settings (mutable — updated by plugin on save)
  settings: RecallSettings | null = null;

  // Callback to persist settings without triggering full reset
  saveSettingsQuiet: (() => Promise<void>) | null = null;

  // VaultSync reference (set by plugin after construction)
  vaultSync: VaultSync | null = null;

  // LLM client
  readonly llmClient: LlmClient;

  // TTS client (cloud)
  readonly ttsClient: TtsClient;

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

  constructor(
    files: StorageFiles,
    private readonly ttsFetch: typeof fetch = fetch,
  ) {
    // Infrastructure
    this.scheduler = new FsrsScheduler();
    this.parser = new MarkdownParser();
    this.syncStateFile = files.syncState;

    // Repositories — plain implementations, no cache logic
    this.conceptRepository = new JsonConceptRepository(files.concepts);
    this.studyItemRepository = new JsonStudyItemRepository(files.studyItems);
    this.deckRepository = new JsonDeckRepository(files.decks);
    this.reviewLog = files.reviewLog;

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
      this.reviewLog,
      this.scheduler,
    );
    this.getDueStudyItemsByDeck = new GetDueStudyItemsByDeck(
      this.studyItemRepository,
      this.conceptRepository,
      this.deckRepository,
      this.reviewLog,
      this.scheduler,
    );
    this.getDeckTree = new GetDeckTree(this.deckRepository, this.studyItemRepository);
    this.getStudyStats = new GetStudyStats(this.studyItemRepository, this.reviewLog);
    this.getLeeches = new GetLeeches(this.studyItemRepository, this.conceptRepository);
    this.importSrData = new ImportSrData(this.studyItemRepository);
    this.replayReviews = new ReplayReviews(this.studyItemRepository, this.reviewLog, this.scheduler);

    // LLM
    this.llmClient = new HttpLlmClient(
      () => this.settings?.llmProvider ?? 'none',
      () => this.settings?.llmApiKey ?? '',
      () => this.settings?.llmModel ?? '',
    );

    // TTS (cloud, OpenAI). Reads its own key — independent from LLM provider.
    // ttsFetch is wired by the plugin layer (obsidianFetch) to bypass renderer CORS.
    this.ttsClient = new OpenAiTtsClient(
      () => this.settings?.voiceTts.apiKey ?? '',
      this.ttsFetch,
    );
  }
}
