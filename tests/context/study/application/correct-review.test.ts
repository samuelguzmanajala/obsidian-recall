import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inMemoryStores, type Stores } from '../../fakes/in-memory';
import { sqliteStores } from '../../../server/persistence/sqlite-stores';
import { CorrectReview, CORRECTION_WINDOW_MS, ReviewCorrectionError } from '@context/study/application/correct-review';
import { ReviewStudyItem } from '@context/study/application/review-study-item';
import { CreateStudyItem } from '@context/study/application/create-study-item';
import { StudyItem } from '@context/study/domain/study-item';
import { StudyItemId } from '@context/study/domain/study-item-id';
import { ConceptId } from '@context/concept/domain/concept-id';
import { Direction } from '@context/study/domain/direction';
import { Rating } from '@context/study/domain/rating';
import { MemoryState } from '@context/study/domain/memory-state';
import { Review } from '@context/study/domain/review';
import { FsrsScheduler } from '@context/study/infrastructure/fsrs-scheduler';

const MIN = 60_000, H = 3_600_000;
const T0 = Date.UTC(2026, 5, 10, 8, 0); // fixed clock: nothing here depends on the wall clock
const { Again, Hard, Good, Easy } = Rating;
type Step = [Rating, number];

const opened: (() => Promise<void>)[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(T0 - H); });
afterEach(async () => { vi.useRealTimers(); for (const close of opened.splice(0)) await close(); });
const backends: [string, () => Stores][] = [
  ['in-memory fakes', inMemoryStores],
  ['SQLite adapters', () => { const s = sqliteStores(); opened.push(s.close); return s; }],
];

describe.each(backends)('CorrectReview (%s)', (_, open) => {
  const scheduler = new FsrsScheduler();
  const id = new StudyItemId('item');
  const fresh = () => StudyItem.create(id, new ConceptId('c'), Direction.AtoB);

  async function setup() {
    const stores = open();
    await stores.studyItems.save(fresh());
    const reviewer = new ReviewStudyItem(stores.studyItems, scheduler, stores.reviews);
    const correct = new CorrectReview(stores.studyItems, scheduler, stores.reviews);
    /** Records through the normal review path, at time `at`. */
    const record = async (rating: Rating, at: number) => {
      vi.setSystemTime(at);
      return (await reviewer.execute({ studyItemId: id.value, rating, origin: 'android' })).reviewId!;
    };
    const state = async () => (await stores.studyItems.findById(id))!.memoryState;
    const log = () => stores.reviews.findLoggedByStudyItemId(id);
    /** The card's state and every stored prior must equal a replay of `history` from scratch. */
    const expectReplayOf = async (history: Step[]) => {
      const chain = fresh();
      const priors = chain.replay(history.map(([rating, t]) => ({ rating, timestamp: new Date(t) })), scheduler);
      expect(await state()).toEqual(chain.memoryState);
      const logged = await log();
      expect(logged.map(e => [e.review.rating, e.review.timestamp.getTime()])).toEqual(history);
      logged.forEach((e, i) => {
        if (i === 0) expect(e.review.prior!.reps).toBe(0); // the initial state (its due is the creation time)
        else expect(e.review.prior).toEqual(priors[i]);
      });
    };
    const now = new Date(T0 + 2 * H);
    return { stores, correct, record, state, log, expectReplayOf, now };
  }

  it('amends the last review', async () => {
    const { correct, record, expectReplayOf, now } = await setup();
    await record(Good, T0);
    const last = await record(Easy, T0 + 10 * MIN);
    const outcome = await correct.execute({ kind: 'amend', reviewId: last, rating: Hard }, now);
    expect(outcome).toMatchObject({ changed: true, target: { id: last } });
    await expectReplayOf([[Good, T0], [Hard, T0 + 10 * MIN]]);
  });

  it('amends an earlier review that was followed by later ones (they are re-applied)', async () => {
    const { correct, record, expectReplayOf, now, log } = await setup();
    const first = await record(Easy, T0);
    await record(Good, T0 + 30 * MIN);
    await record(Again, T0 + 90 * MIN);
    const ids = (await log()).map(e => e.id);
    await correct.execute({ kind: 'amend', reviewId: first, rating: Again }, now);
    await expectReplayOf([[Again, T0], [Good, T0 + 30 * MIN], [Again, T0 + 90 * MIN]]);
    expect((await log()).map(e => e.id)).toEqual(ids);
  });

  it('removes a review in the middle, the last one, and the only one', async () => {
    const { correct, record, expectReplayOf, now, state } = await setup();
    const a = await record(Good, T0);
    const b = await record(Hard, T0 + 20 * MIN);
    const c = await record(Good, T0 + 60 * MIN);
    await correct.execute({ kind: 'remove', reviewId: b }, now);
    await expectReplayOf([[Good, T0], [Good, T0 + 60 * MIN]]);
    await correct.execute({ kind: 'remove', reviewId: c }, now);
    await expectReplayOf([[Good, T0]]);
    await correct.execute({ kind: 'remove', reviewId: a }, now);
    expect((await state()).reps).toBe(0);
    expect((await state()).lastReview).toBeNull();
  });

  it('amends twice, then reverts to the original: state and priors are exactly as before', async () => {
    const { correct, record, expectReplayOf, now, state, log } = await setup();
    const first = await record(Good, T0);
    await record(Good, T0 + 15 * MIN);
    const original = await state();
    const originalLog = await log();
    await correct.execute({ kind: 'amend', reviewId: first, rating: Easy }, now);
    await correct.execute({ kind: 'amend', reviewId: first, rating: Hard }, now);
    await expectReplayOf([[Hard, T0], [Good, T0 + 15 * MIN]]);
    await correct.execute({ kind: 'amend', reviewId: first, rating: Good }, now);
    expect(await state()).toEqual(original);
    expect(await log()).toEqual(originalLog);
  });

  it('removes then restores a review under its id: back to exactly the original', async () => {
    const { correct, record, now, state, log, stores } = await setup();
    await record(Good, T0);
    const middle = await record(Again, T0 + 10 * MIN);
    await record(Good, T0 + 40 * MIN);
    const original = await state();
    const originalLog = await log();
    const removed = await correct.execute({ kind: 'remove', reviewId: middle }, now);
    expect(await stores.reviews.findLogged(middle)).toBeNull();
    const restored = await correct.execute({ kind: 'restore', entry: removed.target }, now);
    expect(restored.changed).toBe(true);
    expect(await state()).toEqual(original);
    expect(await log()).toEqual(originalLog);
    // Restoring again conflicts: it is there already.
    await expect(correct.execute({ kind: 'restore', entry: removed.target }, now)).rejects.toMatchObject({ reason: 'conflict' });
  });

  it('restores the latest review from the current state, and the first one from its own prior', async () => {
    const { correct, record, now, state, log } = await setup();
    const a = await record(Good, T0);
    const b = await record(Good, T0 + 10 * MIN);
    const original = await state();
    const originalLog = await log();
    const removedB = (await correct.execute({ kind: 'remove', reviewId: b }, now)).target;
    const removedA = (await correct.execute({ kind: 'remove', reviewId: a }, now)).target;
    await correct.execute({ kind: 'restore', entry: removedA }, now);
    await correct.execute({ kind: 'restore', entry: removedB }, now);
    expect(await state()).toEqual(original);
    expect(await log()).toEqual(originalLog);
  });

  it('an amend to the same rating writes nothing', async () => {
    const { correct, record, now, state, log } = await setup();
    const r = await record(Good, T0);
    const before = [await state(), await log()];
    expect((await correct.execute({ kind: 'amend', reviewId: r, rating: Good }, now)).changed).toBe(false);
    expect([await state(), await log()]).toEqual(before);
  });

  it('refuses unknown reviews, reviews older than 2 days and reviews of deleted cards', async () => {
    const { correct, record, stores } = await setup();
    const r = await record(Good, T0);
    await expect(correct.execute({ kind: 'amend', reviewId: 999, rating: Hard }, new Date(T0))).rejects.toMatchObject({ reason: 'not-found' });
    await expect(correct.execute({ kind: 'remove', reviewId: r }, new Date(T0 + CORRECTION_WINDOW_MS + 1))).rejects.toMatchObject({ reason: 'outside-window' });
    expect((await correct.execute({ kind: 'amend', reviewId: r, rating: Hard }, new Date(T0 + CORRECTION_WINDOW_MS))).changed).toBe(true);
    await stores.studyItems.remove(id);
    const error = await correct.execute({ kind: 'amend', reviewId: r, rating: Good }, new Date(T0)).catch(e => e);
    expect(error).toBeInstanceOf(ReviewCorrectionError);
    expect(error.reason).toBe('card-missing');
  });

  it('reviews logged before priors were kept: replayed from scratch when the log explains the state', async () => {
    const { stores, correct, expectReplayOf, now } = await setup();
    const legacy: Step[] = [[Good, T0], [Hard, T0 + 20 * MIN]];
    const item = fresh();
    item.replay(legacy.map(([rating, t]) => ({ rating, timestamp: new Date(t) })), scheduler);
    await stores.studyItems.save(item);
    for (const [rating, t] of legacy) await stores.reviews.append(new Review(id, rating, new Date(t)));
    const [first] = await stores.reviews.findLoggedByStudyItemId(id);
    expect(first.review.prior).toBeNull();
    await correct.execute({ kind: 'amend', reviewId: first.id, rating: Easy }, now);
    await expectReplayOf([[Easy, T0], [Hard, T0 + 20 * MIN]]);
  });

  it('refuses (unverifiable) when the stored state is not explained by a log without priors', async () => {
    const { stores, correct, now, state } = await setup();
    const imported = new MemoryState(30, 4, new Date(T0 + 30 * 86_400_000), 9, 1, new Date(T0 - 86_400_000));
    await stores.studyItems.save(StudyItem.reconstitute(id, new ConceptId('c'), Direction.AtoB, imported));
    await stores.reviews.append(new Review(id, Good, new Date(T0)));
    const [entry] = await stores.reviews.findLoggedByStudyItemId(id);
    await expect(correct.execute({ kind: 'amend', reviewId: entry.id, rating: Hard }, now)).rejects.toMatchObject({ reason: 'unverifiable' });
    expect(await state()).toEqual(imported);
  });

  it('imported state with reviews recorded since: corrected from the stored prior, not from scratch', async () => {
    const { stores, correct, record, now, state } = await setup();
    const imported = new MemoryState(30, 4, new Date(T0 - H), 9, 1, new Date(T0 - 30 * 86_400_000));
    await stores.studyItems.save(StudyItem.reconstitute(id, new ConceptId('c'), Direction.AtoB, imported));
    const r = await record(Easy, T0);
    await correct.execute({ kind: 'amend', reviewId: r, rating: Again }, now);
    expect(await state()).toEqual(scheduler.schedule(imported, Again, new Date(T0)));
    expect((await state()).reps).toBe(10);
  });

  it('CreateStudyItem replays the same way (shared StudyItem.replay)', async () => {
    const { stores, record, state } = await setup();
    await record(Good, T0);
    await record(Again, T0 + 10 * MIN);
    const before = await state();
    await stores.studyItems.remove(id);
    await new CreateStudyItem(stores.studyItems, stores.reviews, scheduler).execute({ id: id.value, conceptId: 'c', direction: Direction.AtoB });
    expect(await state()).toEqual(before);
  });
});
