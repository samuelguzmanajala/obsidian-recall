import { afterEach, describe, expect, it } from 'vitest';
import { createIndexer } from './indexer-fixture';
import { inMemoryStores, type Stores } from '../../fakes/in-memory';
import { sqliteStores } from '../../../server/persistence/sqlite-stores';
import { StudyItemId } from '@context/study/domain/study-item-id';
import { DeckId } from '@context/deck/domain/deck-id';
import { Rating } from '@context/study/domain/rating';
import { Review } from '@context/study/domain/review';
import { FsrsScheduler } from '@context/study/infrastructure/fsrs-scheduler';
import { SimilarityMeter, boundedDistance, MAX_COMPARED_LENGTH } from '@context/indexing/domain/card-similarity';

// Edited cards keep their IDs and history (NoteIndexer.inheritEdits), over both storage implementations.
const opened: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of opened.splice(0)) await close(); });
const backends: [string, () => Stores][] = [
  ['in-memory fakes', inMemoryStores],
  ['SQLite adapters', () => { const s = sqliteStores(); opened.push(s.close); return s; }],
];
const key = (a: string, b: string, bidirectional = false) => JSON.stringify([a, b, bidirectional ? 'bidirectional' : 'unidirectional']);
const scheduler = new FsrsScheduler();
let clock = Date.UTC(2026, 0, 1);

describe.each(backends)('NoteIndexer edits over %s', (_, open) => {
  let stores: Stores;
  let indexer: ReturnType<typeof createIndexer>['indexer'];
  const setup = () => { stores = open(); indexer = createIndexer(stores).indexer; };

  async function review(id: string) {
    const item = (await stores.studyItems.findById(new StudyItemId(id)))!;
    const at = new Date(clock += 86_400_000);
    item.review(Rating.Good, scheduler, at);
    await stores.studyItems.save(item);
    await stores.reviews.append(new Review(item.id, Rating.Good, at));
  }
  const items = async () => (await stores.studyItems.findAll()).map(i => ({ id: i.id.value, concept: i.conceptId.value, direction: i.direction, reps: i.memoryState.reps }));
  const concepts = async () => (await stores.concepts.findAll()).map(c => ({ id: c.id.value, sideA: c.sideA.content, sideB: c.sideB.content }));
  const cardKeys = async (path: string) => Object.fromEntries((await stores.sources.get(path))?.cardKeys ?? []);
  const reviewCount = async () => (await stores.reviews.findAll()).length;

  /** Indexes `before`, reviews every item once, then indexes `after`; returns the items before the edit. */
  async function edit(before: string, after: string, path = 'n.md') {
    await indexer.syncFile(path, before);
    const original = await items();
    for (const i of original) await review(i.id);
    await indexer.syncFile(path, after);
    return original;
  }
  async function expectInherited(before: string, after: string, sideA: string, sideB: string) {
    const [item] = await edit(before, after);
    expect(await items()).toEqual([{ ...item, reps: 1 }]);
    expect(await concepts()).toEqual([{ id: item.concept, sideA, sideB }]);
    expect(await cardKeys('n.md')).toEqual({ [key(sideA, sideB)]: item.concept });
    expect((await stores.sources.get('n.md'))!.studyItemIds).toEqual([item.id]);
    expect(await reviewCount()).toBe(1);
    return item;
  }
  async function expectNew(before: string, after: string) {
    const original = await edit(before, after);
    const now = await items();
    expect(now.some(i => original.some(o => o.id === i.id || o.concept === i.concept))).toBe(false);
    expect(now.every(i => i.reps === 0)).toBe(true);
    return { original, now };
  }

  it('rule 1: a fixed question keeps the card', async () => {
    setup();
    await expectInherited('- Capitl of France?::Paris', '- Capital of France?::Paris', 'Capital of France?', 'Paris');
  });

  it('rule 1: a fixed (even rewritten) answer keeps the card, with the new line', async () => {
    setup();
    await expectInherited('- Capital of France?::Pariss', 'Intro\n\n- Capital of France?::Paris', 'Capital of France?', 'Paris');
    expect((await stores.sources.get('n.md'))!.conceptLines.get((await concepts())[0].id)).toBe(3);
    await indexer.syncFile('n.md', '- Capital of France?::The city of Paris');
    expect((await items())[0].reps).toBe(1);
  });

  it('rule 2: small typos on both sides keep the card', async () => {
    setup();
    await expectInherited('- Hauptstadt von Frankreisch::Pariz', '- Hauptstadt   von Frankreich ::Paris', 'Hauptstadt   von Frankreich', 'Paris');
  });

  it('rule 2 below the threshold creates a new card', async () => {
    setup();
    await expectNew('- Apple::Manzana', '- Pear::Pera');
  });

  it('rule 2 needs both sides similar', async () => {
    setup();
    await expectNew('- Hauptstadt von Spanien::Madrid', '- Hauptstadt von Spanie::Barcelona');
  });

  it('two removed cards with one similar added card: no inheritance', async () => {
    setup();
    const { now } = await expectNew('- Q one::Same answer\n- Q two::Same answer', '- Q three::Same answer');
    expect(now).toHaveLength(1);
    expect(await concepts()).toEqual([{ id: now[0].concept, sideA: 'Q three', sideB: 'Same answer' }]);
  });

  it('one removed card with two similar added cards: no inheritance', async () => {
    setup();
    const { now } = await expectNew('- Same question::Answer', '- Same question::Answer one\n- Same question::Answer two');
    expect(now).toHaveLength(2);
  });

  it('pairs several independent edits in one sync, and leaves the unpaired ones alone', async () => {
    setup();
    const before = await edit(
      '- Hund::Dog\n- Katze::Cat\n- Maus::Mous\n- Vogel::Bird\n- Fisch::Fish',
      '- Hund::Hound\n- Katz::Cat\n- Maus::Mouse\n- Vogel::Bird\n- Pferd::Horse',
    );
    const now = await items();
    const byConcept = new Map((await concepts()).map(c => [`${c.sideA}::${c.sideB}`, c.id]));
    const old = (i: number) => before[i].concept;
    expect(byConcept.get('Hund::Hound')).toBe(old(0));
    expect(byConcept.get('Katz::Cat')).toBe(old(1));
    expect(byConcept.get('Maus::Mouse')).toBe(old(2));
    expect(byConcept.get('Vogel::Bird')).toBe(old(3));
    expect([...byConcept.values()]).not.toContain(old(4)); // Fisch::Fish → Pferd::Horse is not an edit
    expect(now.filter(i => i.reps === 1)).toHaveLength(4);
    expect(await reviewCount()).toBe(5);
  });

  it('does not inherit when the old card is shared with another note', async () => {
    setup();
    await indexer.syncFile('other.md', '- Question::Answer');
    const [item] = await edit('- Question::Answer', '- Question::Answer!');
    const now = await items();
    expect(now).toHaveLength(2);
    expect(now.find(i => i.id === item.id)).toMatchObject({ reps: 1, concept: item.concept });
    expect(await cardKeys('other.md')).toEqual({ [key('Question', 'Answer')]: item.concept });
    expect(Object.values(await cardKeys('n.md'))).not.toContain(item.concept);
  });

  it('does not inherit into content that already exists elsewhere: it links to it as before', async () => {
    setup();
    await indexer.syncFile('other.md', '- Question::Answer!');
    const shared = (await items())[0];
    const old = (await edit('- Question::Answer', '- Question::Answer!')).find(i => i.id !== shared.id)!;
    expect(await cardKeys('n.md')).toEqual({ [key('Question', 'Answer!')]: shared.concept });
    expect((await items()).map(i => i.id)).toEqual([shared.id]);
    expect(old.id).not.toBe(shared.id);
  });

  it('a bidirectional card keeps both study items and both histories', async () => {
    setup();
    const original = await edit('- Haus:::Casa', '- Das Haus:::Casa');
    expect(original).toHaveLength(2);
    expect(await items()).toEqual(original.map(i => ({ ...i, reps: 1 })));
    expect((await stores.sources.get('n.md'))!.studyItemIds).toEqual(original.map(i => i.id));
    expect(await stores.sources.aliasFor(key('Das Haus', 'Casa', true))).toEqual({ conceptId: original[0].concept, aToB: original[0].id, bToA: original[1].id });
  });

  it('a tag change and an edit in the same sync move the kept items to the new decks', async () => {
    setup();
    const [item] = await edit('---\ntags: [old]\n---\n- Question::Answr', '---\ntags: [new]\n---\n- Question::Answer');
    const deck = async (tag: string) => (await stores.decks.findById(new DeckId((await stores.sources.deckForTag(tag))!)))!.studyItemIds.map(i => i.value);
    expect(await deck('new')).toEqual([item.id]);
    expect(await deck('old')).toEqual([]);
    expect(await items()).toEqual([{ ...item, reps: 1 }]);
  });

  it('(a) the edited content added to another note links to the inherited concept', async () => {
    setup();
    const [item] = await edit('- Question::Answr', '- Question::Answer');
    await indexer.syncFile('b.md', '- Question::Answer');
    expect(await cardKeys('b.md')).toEqual({ [key('Question', 'Answer')]: item.concept });
    expect((await stores.sources.get('b.md'))!.studyItemIds).toEqual([item.id]);
    expect(await items()).toEqual([{ ...item, reps: 1 }]);
    // Removing it from the first note keeps it alive through the second
    await indexer.syncFile('n.md', '- Other::Card');
    expect((await items()).find(i => i.id === item.id)).toMatchObject({ reps: 1 });
  });

  it('(b) the pre-edit content added again gets fresh, stable IDs, never the edited card', async () => {
    setup();
    const [item] = await edit('- Question::Answr', '- Question::Answer');
    await indexer.syncFile('b.md', '- Question::Answr');
    const fresh = (await items()).find(i => i.id !== item.id)!;
    expect(fresh).toMatchObject({ reps: 0 });
    expect(fresh.concept).not.toBe(item.concept);
    expect(await concepts()).toEqual([
      { id: item.concept, sideA: 'Question', sideB: 'Answer' },
      { id: fresh.concept, sideA: 'Question', sideB: 'Answr' },
    ]);
    // Deterministic: the same content resolves to the same salted IDs, in another note too
    await indexer.syncFile('c.md', '- Question::Answr');
    expect(await cardKeys('c.md')).toEqual({ [key('Question', 'Answr')]: fresh.concept });
    await indexer.removeFile('b.md');
    await indexer.removeFile('c.md');
    await indexer.syncFile('b.md', '- Question::Answr');
    expect(await cardKeys('b.md')).toEqual({ [key('Question', 'Answr')]: fresh.concept });
    // Even with the edited card gone, its hash-derived IDs stay reserved for its alias
    await indexer.removeFile('b.md');
    await indexer.removeFile('n.md');
    await indexer.syncFile('d.md', '- Question::Answr');
    expect(await items()).toEqual([fresh]);
  });

  it('(c) an edited card removed and re-added elsewhere gets its IDs and history back', async () => {
    setup();
    const [item] = await edit('- Question::Answr', '- Question::Answer\n- Other::Card');
    await indexer.syncFile('n.md', '- Other::Card');
    expect((await items()).some(i => i.id === item.id)).toBe(false);
    await indexer.syncFile('moved.md', '- Question::Answer');
    expect(await cardKeys('moved.md')).toEqual({ [key('Question', 'Answer')]: item.concept });
    expect((await items()).find(i => i.id === item.id)).toEqual({ ...item, reps: 1 });
    expect(await reviewCount()).toBe(1);
  });

  it('A → B → C keeps one continuous history; the stale alias of B is dropped', async () => {
    setup();
    const [item] = await edit('- Question::Answr', '- Question::Answer');
    await review(item.id);
    await indexer.syncFile('n.md', '- Question::The answer');
    await review(item.id);
    expect(await items()).toEqual([{ ...item, reps: 3 }]);
    expect(await stores.sources.aliasFor(key('Question', 'Answer'))).toBeNull();
    expect(await stores.sources.aliasFor(key('Question', 'The answer'))).toMatchObject({ conceptId: item.concept });
    // B is now ordinary new content with its own IDs
    await indexer.syncFile('b.md', '- Question::Answer');
    expect((await items()).find(i => i.id !== item.id)).toMatchObject({ reps: 0 });
    // Reverting to A is an edit too and keeps the same card
    await indexer.syncFile('n.md', '- Question::Answr');
    expect((await items()).find(i => i.id === item.id)).toMatchObject({ reps: 3 });
    expect(await cardKeys('n.md')).toEqual({ [key('Question', 'Answr')]: item.concept });
  });

  it('(d) a directionality change is not an edit', async () => {
    setup();
    await expectNew('- Question::Answer', '- Question:::Answer');
  });
});

describe('card similarity', () => {
  it('normalizes whitespace, keeps case and accents, bounds the work', () => {
    const meter = new SimilarityMeter();
    expect(meter.similar('  a  b\n c ', 'a b c')).toBe(true);
    expect(meter.similar('Ab', 'ab')).toBe(false); // case counts: 1 edit in 2 > 0
    expect(meter.similar('Árbol', 'arbol')).toBe(true); // accents count: 1 edit in 5
    expect(meter.similar('Árbol', 'árbal')).toBe(false); // 2 edits in 5
    expect(meter.similar('abcdefghij', 'abcdefghXY')).toBe(true); // 2 edits in 10
    expect(meter.similar('abcdefghij', 'abcdefgXYZ')).toBe(false); // 3 edits in 10
    expect(meter.similar('abcde', 'abcdefghij')).toBe(false); // ruled out by length
    const long = 'x'.repeat(MAX_COMPARED_LENGTH + 1);
    expect(meter.similar(long, long + 'y')).toBeNull();
    expect(boundedDistance([...'kitten'], [...'sitting'], 3)).toBe(3);
    expect(boundedDistance([...'kitten'], [...'sitting'], 2)).toBe(3);
  });
});
