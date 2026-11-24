import type { Container } from '../container';
import { Direction } from '../../context/study/domain/direction';
import type { Scheduler } from '../../context/study/domain/scheduler';
import { MemoryState } from '../../context/study/domain/memory-state';

/**
 * Compact read models for the MCP tools. Outputs go to an LLM, often in a voice conversation:
 * Markdown sides are returned as text (never rendered), cut at `MAX_SIDE_CHARS`.
 */
export const MAX_SIDE_CHARS = 500;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

/** A card the user studies in one direction: what is asked and what is expected. */
export interface CardView {
  studyItemId: string;
  prompt: string;
  answer: string;
  /** Deck paths as tags ("German/grammar"); usually one. */
  decks: string[];
  state: 'new' | 'review';
  /** ISO time the card is (or was) due; absent for new cards. */
  due?: string;
  reps: number;
  lapses: number;
  /** The card's revision (as in `GET /api/v1/due`): changes whenever it is reviewed or edited. `record_review` takes it. */
  revision: number;
  /** Present when the prompt or the answer was cut at `MAX_SIDE_CHARS` (marked with "…"). */
  truncated?: true;
  /** When the card would come back if rated now with each rating. */
  next: NextPreview;
}

/**
 * Where a card comes from in the vault: the note (vault-relative path, as the plugin publishes it) and the
 * line of the card in it. Lets a tutor read the note that explains the card. `null` when no note holds it.
 */
export interface CardSource { note: string; line: number }

/** The note a concept's card is written in (the first one, in vault order, when several notes hold it). */
export async function sourceOfConcept(c: Container, conceptId: string): Promise<CardSource | null> {
  const location = await c.sources.locate(conceptId);
  return location ? { note: location.filePath, line: location.line } : null;
}

/** Per rating: `in` = interval ("10m", "5h", "3d") and `due` = ISO time to the minute ("2026-11-12T10:10Z"). */
export type NextPreview = Record<'again' | 'hard' | 'good' | 'easy', { in: string; due: string }>;

/**
 * The scheduler's own preview (`Scheduler.previewAll`, the computation behind the HTTP API's
 * `preview`), rated at `now`; pure, no state is written. Under a day the interval is given in
 * minutes or hours, where the HTTP preview's whole days would say 0; from a day on it is that
 * preview's `intervalDays`.
 */
export function nextPreview(scheduler: Scheduler, state: MemoryState, now: Date): NextPreview {
  const out = {} as NextPreview;
  for (const p of scheduler.previewAll(state, now)) {
    const ms = p.nextDue.getTime() - now.getTime();
    const interval = ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))}m` : ms < 86_400_000 ? `${Math.round(ms / 3_600_000)}h` : `${p.intervalDays}d`;
    out[p.rating as keyof NextPreview] = { in: interval, due: `${p.nextDue.toISOString().slice(0, 16)}Z` };
  }
  return out;
}
/** Time from `now` to `due` like the `in` of `next` ("10m", "5h", "3d"), or "now" when already due. */
export function untilText(due: Date, now: Date): string {
  const ms = due.getTime() - now.getTime();
  if (ms <= 0) return 'now';
  return ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))}m` : ms < 86_400_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 86_400_000)}d`;
}
/** ISO time to the minute ("2026-11-12T10:10Z"), as in `next`. */
export const minuteIso = (d: Date) => `${d.toISOString().slice(0, 16)}Z`;
export const memoryState = (m: { stability: number; difficulty: number; due: Date; reps: number; lapses: number; lastReview: Date | null }) =>
  new MemoryState(m.stability, m.difficulty, m.due, m.reps, m.lapses, m.lastReview);

export function clip(text: string): { text: string; cut: boolean } {
  const chars = [...text]; // code points: never split a surrogate pair
  return chars.length <= MAX_SIDE_CHARS ? { text, cut: false } : { text: `${chars.slice(0, MAX_SIDE_CHARS).join('').trimEnd()}…`, cut: true };
}

export interface CardFacts {
  studyItemId: string; sideA: string; sideB: string; direction: Direction; reps: number; lapses: number; due?: Date;
}
export function cardView(facts: CardFacts, decks: string[], next: NextPreview, revision: number): CardView {
  const aToB = facts.direction === Direction.AtoB;
  const prompt = clip(aToB ? facts.sideA : facts.sideB), answer = clip(aToB ? facts.sideB : facts.sideA);
  return {
    studyItemId: facts.studyItemId, prompt: prompt.text, answer: answer.text, decks,
    state: facts.reps === 0 ? 'new' : 'review',
    ...(facts.reps > 0 && facts.due ? { due: facts.due.toISOString() } : {}),
    reps: facts.reps, lapses: facts.lapses, revision,
    ...(prompt.cut || answer.cut ? { truncated: true as const } : {}),
    next,
  };
}

/** Deck hierarchy read once per call: paths, card membership and subtree filters, without further queries. */
export class DeckIndex {
  private readonly names = new Map<string, { name: string; parent: string | null }>();
  private readonly children = new Map<string, string[]>();
  private readonly direct = new Map<string, string[]>();
  private readonly ofItem = new Map<string, string[]>();
  private constructor() {}

  static async load(c: Container): Promise<DeckIndex> {
    const index = new DeckIndex();
    for (const deck of await c.deckRepository.findAll()) {
      const id = deck.id.value, parent = deck.parentId?.value ?? null;
      index.names.set(id, { name: deck.name, parent });
      if (parent) index.children.set(parent, [...(index.children.get(parent) ?? []), id]);
      const items = deck.studyItemIds.map(i => i.value);
      index.direct.set(id, items);
      for (const item of items) index.ofItem.set(item, [...(index.ofItem.get(item) ?? []), id]);
    }
    return index;
  }
  has(deckId: string): boolean { return this.names.has(deckId); }
  /** Whether a deck with this path exists ("German/grammar"; case-insensitive, like tags). */
  hasPath(path: string): boolean {
    const wanted = path.toLowerCase();
    return [...this.names.keys()].some(id => this.path(id).toLowerCase() === wanted);
  }
  /** "German/grammar": names from the root, like the tag that created the deck. */
  path(deckId: string): string {
    const parts: string[] = [];
    const seen = new Set<string>();
    for (let id: string | null = deckId; id && !seen.has(id); id = this.names.get(id)?.parent ?? null) {
      seen.add(id);
      parts.unshift(this.names.get(id)?.name ?? '?');
    }
    return parts.join('/');
  }
  decksOf(studyItemId: string): string[] {
    return (this.ofItem.get(studyItemId) ?? []).map(id => this.path(id));
  }
  /** Study items of a deck and all its subdecks. */
  subtree(deckId: string): Set<string> {
    const items = new Set<string>();
    const stack = [deckId], seen = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const item of this.direct.get(id) ?? []) items.add(item);
      stack.push(...(this.children.get(id) ?? []));
    }
    return items;
  }
}
