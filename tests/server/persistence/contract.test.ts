import { afterEach, describe, expect, it } from 'vitest';
import { inMemoryStores, type Stores } from '../../context/fakes/in-memory';
import { sqliteStores } from './sqlite-stores';
import { Concept } from '@context/concept/domain/concept';
import { ConceptId } from '@context/concept/domain/concept-id';
import { Side } from '@context/concept/domain/side';
import { Directionality } from '@context/concept/domain/directionality';
import { StudyItem } from '@context/study/domain/study-item';
import { StudyItemId } from '@context/study/domain/study-item-id';
import { MemoryState } from '@context/study/domain/memory-state';
import { Direction } from '@context/study/domain/direction';
import { Deck } from '@context/deck/domain/deck';
import { DeckId } from '@context/deck/domain/deck-id';
import { Review } from '@context/study/domain/review';
import { Rating } from '@context/study/domain/rating';
import type { FileIndex } from '@context/indexing/domain/source-index';

// The same behaviour, including iteration order, from the test doubles and the production adapters.
const opened: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of opened.splice(0)) await close(); });
const backends: [string, () => Stores][] = [
  ['in-memory fakes', inMemoryStores],
  ['SQLite adapters', () => { const s = sqliteStores(); opened.push(s.close); return s; }],
];

const concept = (id: string, a = 'A') => Concept.create(new ConceptId(id), new Side(a), new Side('B'), Directionality.Bidirectional);
const item = (id: string, conceptId = 'c', due = 1000, reps = 0) => StudyItem.reconstitute(new StudyItemId(id), new ConceptId(conceptId),
  Direction.AtoB, new MemoryState(1.5, 4.25, new Date(due), reps, 1, reps ? new Date(due - 10) : null));
const ids = (xs: { id: { value: string } }[]) => xs.map(x => x.id.value);
const review = (id: string, t: number, rating = Rating.Good) => new Review(new StudyItemId(id), rating, new Date(t));
const index = (cards: [string, string][], items: string[] = [], decks: string[] = []): FileIndex =>
  ({ cardKeys: new Map(cards), conceptLines: new Map(cards.map(([, c], i) => [c, i + 1])), studyItemIds: items, deckIds: decks });

describe.each(backends)('%s', (_, open) => {
  it('concepts: upsert keeps position, remove and re-add goes last', async () => {
    const { concepts } = open();
    for (const id of ['x', 'y', 'z']) await concepts.save(concept(id));
    await concepts.save(concept('x', 'changed'));
    expect(ids(await concepts.findAll())).toEqual(['x', 'y', 'z']);
    expect((await concepts.findById(new ConceptId('x')))!.sideA.content).toBe('changed');
    await concepts.remove(new ConceptId('x'));
    await concepts.save(concept('x'));
    expect(ids(await concepts.findAll())).toEqual(['y', 'z', 'x']);
    expect(await concepts.findById(new ConceptId('missing'))).toBeNull();
  });

  it('study items: exact memory state, due filter and concept lookup in storage order', async () => {
    const { studyItems } = open();
    await studyItems.save(item('b', 'c1', 3000, 2));
    await studyItems.save(item('a', 'c2', 1000));
    await studyItems.save(item('c', 'c1', 2000));
    await studyItems.save(item('b', 'c1', 500, 3));
    expect(ids(await studyItems.findDue(new Date(2000)))).toEqual(['b', 'a', 'c']);
    expect(ids(await studyItems.findDue(new Date(1999)))).toEqual(['b', 'a']);
    expect(ids(await studyItems.findByConceptId(new ConceptId('c1')))).toEqual(['b', 'c']);
    expect(await studyItems.findById(new StudyItemId('b'))).toEqual(item('b', 'c1', 500, 3));
    await studyItems.remove(new StudyItemId('b'));
    await studyItems.save(item('b'));
    expect(ids(await studyItems.findAll())).toEqual(['a', 'c', 'b']);
  });

  it('decks: hierarchy queries and item order follow Set semantics', async () => {
    const { decks } = open();
    const root = Deck.create(new DeckId('r'), 'Root');
    await decks.save(root);
    await decks.save(Deck.create(new DeckId('k2'), 'Second', new DeckId('r')));
    await decks.save(Deck.create(new DeckId('k1'), 'First', new DeckId('r')));
    for (const id of ['1', '2', '3']) root.addStudyItem(new StudyItemId(id));
    await decks.save(root);
    const loaded = (await decks.findById(new DeckId('r')))!;
    loaded.removeStudyItem(new StudyItemId('1'));
    loaded.addStudyItem(new StudyItemId('4'));
    loaded.addStudyItem(new StudyItemId('1'));
    await decks.save(loaded);
    expect((await decks.findById(new DeckId('r')))!.studyItemIds.map(i => i.value)).toEqual(['2', '3', '4', '1']);
    expect(ids(await decks.findRoots())).toEqual(['r']);
    expect(ids(await decks.findByParentId(new DeckId('r')))).toEqual(['k2', 'k1']);
    await decks.remove(new DeckId('k2'));
    expect(ids(await decks.findAll())).toEqual(['r', 'k1']);
  });

  it('review log: one event per item and timestamp, ordered by time then insertion', async () => {
    const { reviews } = open();
    await reviews.append(review('a', 3000));
    await reviews.append(review('b', 1000));
    await reviews.append(review('c', 3000));
    await reviews.append(review('a', 3000, Rating.Again)); // ignored: same item and timestamp
    await reviews.append(review('a', 500));
    const all = await reviews.findAll();
    expect(all.map(r => `${r.studyItemId.value}@${r.timestamp.getTime()}:${r.rating}`)).toEqual(['a@500:good', 'b@1000:good', 'a@3000:good', 'c@3000:good']);
    expect((await reviews.findByStudyItemId(new StudyItemId('a'))).map(r => r.timestamp.getTime())).toEqual([500, 3000]);
    expect((await reviews.findSince(new Date(1000))).length).toBe(3);
    expect(await reviews.countSince(new Date(1000))).toBe(3);
    expect(await reviews.countFirstReviewedSince(new Date(1000))).toBe(2); // b and c; a was first reviewed at 500
  });

  it('source index: Map-like file order, lookups by concept and tag, snapshot', async () => {
    const { sources } = open();
    expect(await sources.snapshot()).toEqual({ fileIndices: {}, tagToDeckId: {} });
    await sources.put('a.md', index([['k1', 'c1'], ['k2', 'c2']], ['i1', 'i1'], ['d1']));
    await sources.put('b.md', index([['k1', 'c1']], ['i1'], ['d2', 'd2']));
    await sources.put('c.md', index([['k3', 'c3']]));
    await sources.put('a.md', index([['k2', 'c2'], ['k1', 'c1']], ['i2'], ['d1']));
    expect(Object.keys((await sources.snapshot()).fileIndices)).toEqual(['a.md', 'b.md', 'c.md']);
    expect(await sources.get('a.md')).toEqual(index([['k2', 'c2'], ['k1', 'c1']], ['i2'], ['d1']));
    expect(await sources.get('missing.md')).toBeNull();
    expect(await sources.otherFilesWithConcept('c1', 'a.md')).toEqual([{ path: 'b.md', deckIds: ['d2', 'd2'] }]);
    expect(await sources.otherFilesWithConcept('c1', 'x.md')).toEqual([{ path: 'a.md', deckIds: ['d1'] }, { path: 'b.md', deckIds: ['d2', 'd2'] }]);
    expect(await sources.locate('c1')).toEqual({ filePath: 'a.md', line: 2 });
    expect(await sources.locate('nope')).toBeNull();
    await sources.rename('a.md', 'z.md');
    await sources.rename('missing.md', 'other.md');
    expect(Object.keys((await sources.snapshot()).fileIndices)).toEqual(['b.md', 'c.md', 'z.md']);
    expect(await sources.locate('c1')).toEqual({ filePath: 'b.md', line: 1 });
    await sources.rename('z.md', 'b.md'); // onto an existing path: keeps that path's position
    expect(Object.keys((await sources.snapshot()).fileIndices)).toEqual(['b.md', 'c.md']);
    expect(await sources.get('b.md')).toEqual(index([['k2', 'c2'], ['k1', 'c1']], ['i2'], ['d1']));
    await sources.remove('b.md');
    await sources.put('b.md', index([]));
    expect(Object.keys((await sources.snapshot()).fileIndices)).toEqual(['c.md', 'b.md']);
    await sources.setDeckForTag('t2', 'd2');
    await sources.setDeckForTag('t1', 'd1');
    expect(await sources.deckForTag('t1')).toBe('d1');
    expect(await sources.deckForTag('none')).toBeNull();
    expect((await sources.snapshot()).tagToDeckId).toEqual({ t2: 'd2', t1: 'd1' });
    expect(JSON.stringify(await sources.snapshot())).toBe(JSON.stringify({
      fileIndices: {
        'c.md': { cardKeys: { k3: 'c3' }, conceptLines: { c3: 1 }, studyItemIds: [], deckIds: [] },
        'b.md': { cardKeys: {}, conceptLines: {}, studyItemIds: [], deckIds: [] },
      },
      tagToDeckId: { t2: 'd2', t1: 'd1' },
    }));
  });

  it('source index: card lookup across files and durable card aliases, one key per concept', async () => {
    const { sources } = open();
    await sources.put('a.md', index([['k1', 'c1']]));
    await sources.put('b.md', index([['k2', 'c2'], ['k1', 'c9']]));
    expect(await sources.conceptForCard('k1')).toBe('c1');
    expect(await sources.conceptForCard('k2')).toBe('c2');
    expect(await sources.conceptForCard('nope')).toBeNull();
    await sources.remove('a.md');
    expect(await sources.conceptForCard('k1')).toBe('c9');

    expect(await sources.aliasFor('k1')).toBeNull();
    expect(await sources.aliasOwner('c1')).toBeNull();
    await sources.setAlias('k1', { conceptId: 'c1', aToB: 'i1', bToA: 'j1' });
    await sources.setAlias('k3', { conceptId: 'c3', aToB: 'i3', bToA: null });
    expect(await sources.aliasFor('k1')).toEqual({ conceptId: 'c1', aToB: 'i1', bToA: 'j1' });
    expect(await sources.aliasFor('k3')).toEqual({ conceptId: 'c3', aToB: 'i3', bToA: null });
    for (const id of ['c1', 'i1', 'j1']) expect(await sources.aliasOwner(id)).toBe('k1');
    expect(await sources.aliasOwner('i3')).toBe('k3');
    // The same concept edited again: the alias moves to the new key, the old key loses it
    await sources.setAlias('k4', { conceptId: 'c1', aToB: 'i1', bToA: 'j1' });
    expect(await sources.aliasFor('k1')).toBeNull();
    expect(await sources.aliasOwner('j1')).toBe('k4');
    // Another concept taking a key replaces that key's alias
    await sources.setAlias('k4', { conceptId: 'c5', aToB: 'i5', bToA: null });
    expect(await sources.aliasOwner('c1')).toBeNull();
    expect(await sources.aliasFor('k4')).toEqual({ conceptId: 'c5', aToB: 'i5', bToA: null });
    // Aliases are not part of the note index, its snapshot or file operations
    await sources.remove('b.md');
    expect(await sources.aliasFor('k3')).toEqual({ conceptId: 'c3', aToB: 'i3', bToA: null });
    expect(await sources.snapshot()).toEqual({ fileIndices: {}, tagToDeckId: {} });
  });
});

it('SQLite adapters refuse access outside a transaction', async () => {
  const stores = sqliteStores();
  stores.db.sql.exec('COMMIT');
  await expect(stores.concepts.findAll()).rejects.toThrow('Storage access requires a transaction');
  stores.db.sql.exec('BEGIN');
  await stores.close();
});
