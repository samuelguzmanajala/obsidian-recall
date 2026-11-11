import { NoteIndexer } from '@context/indexing/application/note-indexer';
import { MarkdownParser } from '@context/concept/infrastructure/markdown-parser';
import { JsonConceptRepository } from '@context/concept/infrastructure/json-concept-repository';
import { JsonStudyItemRepository } from '@context/study/infrastructure/json-study-item-repository';
import { JsonDeckRepository } from '@context/deck/infrastructure/json-deck-repository';
import { MultiDeviceReviewLog } from '@context/study/infrastructure/json-review-log';
import { FsrsScheduler } from '@context/study/infrastructure/fsrs-scheduler';
import { CreateConcept } from '@context/concept/application/create-concept';
import { RemoveConcept } from '@context/concept/application/remove-concept';
import { CreateStudyItem } from '@context/study/application/create-study-item';
import { RemoveStudyItem } from '@context/study/application/remove-study-item';
import { CreateDeck } from '@context/deck/application/create-deck';
import { NestDeck } from '@context/deck/application/nest-deck';
import { AddStudyItemToDeck } from '@context/deck/application/add-study-item-to-deck';
import { RemoveStudyItemFromDeck } from '@context/deck/application/remove-study-item-from-deck';
import type { JsonFileStorage, SerializedReview } from '@context/shared/infrastructure/json-storage';

/** Named JSON documents, shaped like the server's SQLite `documents` table. */
export type DocumentStore = Record<string, unknown>;

export function document(store: DocumentStore, key: string): JsonFileStorage {
  return {
    read: async <T>() => (store[key] ?? null) as T | null,
    write: async <T>(value: T) => { store[key] = JSON.parse(JSON.stringify(value)); },
  };
}

/** Wires a NoteIndexer over in-memory documents the way the server composition root does. */
export function createIndexer(store: DocumentStore = {}, allowedTags: string[] = []) {
  const reviews = document(store, 'reviews');
  const readReviews = async () => await reviews.read<SerializedReview[]>() ?? [];
  const reviewLog = new MultiDeviceReviewLog({ readLocal: readReviews, readAll: readReviews, writeLocal: v => reviews.write(v) });
  const conceptRepository = new JsonConceptRepository(document(store, 'concepts'));
  const studyItemRepository = new JsonStudyItemRepository(document(store, 'study-items'));
  const deckRepository = new JsonDeckRepository(document(store, 'decks'));
  const indexer = new NoteIndexer({
    parser: new MarkdownParser(),
    syncState: document(store, 'sync-state'),
    studyItemRepository,
    deckRepository,
    createConcept: new CreateConcept(conceptRepository),
    removeConcept: new RemoveConcept(conceptRepository),
    createStudyItem: new CreateStudyItem(studyItemRepository, reviewLog, new FsrsScheduler()),
    removeStudyItem: new RemoveStudyItem(studyItemRepository),
    createDeck: new CreateDeck(deckRepository),
    nestDeck: new NestDeck(deckRepository),
    addStudyItemToDeck: new AddStudyItemToDeck(deckRepository),
    removeStudyItemFromDeck: new RemoveStudyItemFromDeck(deckRepository),
    allowedTags,
  });
  return { indexer, store, conceptRepository, studyItemRepository, deckRepository };
}
