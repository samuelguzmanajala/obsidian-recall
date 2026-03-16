import { JsonStoragePort } from '@context/shared/infrastructure/json-storage';

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

export class Container {
  // Repositories
  readonly conceptRepository: JsonConceptRepository;
  readonly studyItemRepository: JsonStudyItemRepository;
  readonly deckRepository: JsonDeckRepository;
  readonly reviewLog: JsonReviewLog;

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

  constructor(storage: JsonStoragePort) {
    // Infrastructure
    this.scheduler = new FsrsScheduler();
    this.parser = new MarkdownParser();

    // Repositories
    this.conceptRepository = new JsonConceptRepository(storage);
    this.studyItemRepository = new JsonStudyItemRepository(storage);
    this.deckRepository = new JsonDeckRepository(storage);
    this.reviewLog = new JsonReviewLog(storage);

    // Use cases
    this.createConcept = new CreateConcept(this.conceptRepository);
    this.updateConcept = new UpdateConcept(this.conceptRepository);
    this.removeConcept = new RemoveConcept(this.conceptRepository);

    this.createStudyItem = new CreateStudyItem(this.studyItemRepository);
    this.removeStudyItem = new RemoveStudyItem(this.studyItemRepository);
    this.reviewStudyItem = new ReviewStudyItem(
      this.studyItemRepository,
      this.reviewLog,
      this.scheduler,
    );

    this.createDeck = new CreateDeck(this.deckRepository);
    this.nestDeck = new NestDeck(this.deckRepository);
    this.removeDeck = new RemoveDeck(this.deckRepository);
    this.addStudyItemToDeck = new AddStudyItemToDeck(this.deckRepository);
    this.removeStudyItemFromDeck = new RemoveStudyItemFromDeck(this.deckRepository);
  }
}
