import { NoteIndexer } from '@context/indexing/application/note-indexer';
import { MarkdownParser } from '@context/concept/infrastructure/markdown-parser';
import { FsrsScheduler } from '@context/study/infrastructure/fsrs-scheduler';
import { CreateConcept } from '@context/concept/application/create-concept';
import { RemoveConcept } from '@context/concept/application/remove-concept';
import { UpdateConcept } from '@context/concept/application/update-concept';
import { CreateStudyItem } from '@context/study/application/create-study-item';
import { RemoveStudyItem } from '@context/study/application/remove-study-item';
import { CreateDeck } from '@context/deck/application/create-deck';
import { NestDeck } from '@context/deck/application/nest-deck';
import { AddStudyItemToDeck } from '@context/deck/application/add-study-item-to-deck';
import { RemoveStudyItemFromDeck } from '@context/deck/application/remove-study-item-from-deck';
import { inMemoryStores, type Stores } from '../../fakes/in-memory';

/** Wires a NoteIndexer over storage ports the way the server composition root does. */
export function createIndexer(stores: Stores = inMemoryStores(), allowedTags: string[] = []) {
  const { concepts: conceptRepository, studyItems: studyItemRepository, decks: deckRepository } = stores;
  const indexer = new NoteIndexer({
    parser: new MarkdownParser(),
    sources: stores.sources,
    studyItemRepository,
    deckRepository,
    conceptRepository,
    createConcept: new CreateConcept(conceptRepository),
    updateConcept: new UpdateConcept(conceptRepository),
    removeConcept: new RemoveConcept(conceptRepository),
    createStudyItem: new CreateStudyItem(studyItemRepository, stores.reviews, new FsrsScheduler()),
    removeStudyItem: new RemoveStudyItem(studyItemRepository),
    createDeck: new CreateDeck(deckRepository),
    nestDeck: new NestDeck(deckRepository),
    addStudyItemToDeck: new AddStudyItemToDeck(deckRepository),
    removeStudyItemFromDeck: new RemoveStudyItemFromDeck(deckRepository),
    allowedTags,
  });
  return { indexer, stores, conceptRepository, studyItemRepository, deckRepository };
}

/** The indexer's state in the legacy document shapes (as the v2 `documents` table held them). */
export async function documents(stores: Stores) {
  const map = <T extends { id: { value: string } }>(xs: T[], f: (x: T) => unknown) => Object.fromEntries(xs.map(x => [x.id.value, f(x)]));
  return {
    decks: map(await stores.decks.findAll(), d => ({ id: d.id.value, name: d.name, parentId: d.parentId?.value ?? null, studyItemIds: d.studyItemIds.map(i => i.value) })),
    concepts: map(await stores.concepts.findAll(), c => ({ id: c.id.value, sideA: c.sideA.content, sideB: c.sideB.content, directionality: c.directionality })),
    'study-items': map(await stores.studyItems.findAll(), i => ({
      id: i.id.value, conceptId: i.conceptId.value, direction: i.direction,
      memoryState: { ...i.memoryState, due: i.memoryState.due.toISOString(), lastReview: i.memoryState.lastReview?.toISOString() ?? null },
    })),
    'sync-state': await stores.sources.snapshot(),
  };
}
