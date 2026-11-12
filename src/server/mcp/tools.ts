import type { RecallService } from '../service';
import { Direction } from '../../context/study/domain/direction';
import { StudyItemId } from '../../context/study/domain/study-item-id';
import { ConceptId } from '../../context/concept/domain/concept-id';
import { cardView, clip, DEFAULT_LIMIT, DeckIndex, MAX_LIMIT, MAX_SIDE_CHARS, memoryState, nextPreview } from './card-views';
import { foldText } from '../../context/concept/domain/text-match';

/** MCP tool annotations (hints for the client; never trusted for security). */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
/** One MCP tool. Adding a tool to the connector means adding an entry to `RECALL_TOOLS`. */
export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown> & { type: 'object' };
  annotations: ToolAnnotations;
  /** `args` is the raw `arguments` object of `tools/call`; validate it. Throw `ToolInputError` for bad input. */
  call(service: RecallService, args: Record<string, unknown>): Promise<ToolResult>;
}
export class ToolInputError extends Error {}

export function json(value: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// ---- Arguments: strict (unknown keys and wrong types are rejected); null counts as "not given" ----

type Args = Record<string, unknown>;
export function onlyKeys(args: Args, allowed: readonly string[]): void {
  const extra = Object.keys(args).filter(k => !allowed.includes(k));
  if (extra.length) throw new ToolInputError(`Unknown argument(s): ${extra.join(', ')}. Allowed: ${allowed.join(', ') || 'none'}`);
}
export function intArg(args: Args, name: string, min: number, max: number, fallback: number): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ToolInputError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}
export const limitArg = (args: Args) => intArg(args, 'limit', 1, MAX_LIMIT, DEFAULT_LIMIT);
function deckArg(args: Args): string | undefined {
  const value = args.deckId;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.length || value.length > 256) throw new ToolInputError('deckId must be the id of a deck from list_decks');
  return value;
}
/** Resolves an optional `deckId` against the deck tree; `undefined` filter = all decks. */
function deckFilter(decks: DeckIndex, deckId: string | undefined): { deck: string | null; allows: (studyItemId: string) => boolean } {
  if (deckId === undefined) return { deck: null, allows: () => true };
  if (!decks.has(deckId)) throw new ToolInputError(`Unknown deckId "${deckId}": pass the "id" of a deck returned by list_decks`);
  const items = decks.subtree(deckId);
  return { deck: decks.path(deckId), allows: id => items.has(id) };
}

export const DECK_ID = { type: 'string', description: 'Optional. The "id" of a deck exactly as returned by list_decks (not its name). '
  + 'Restricts results to that deck and all of its subdecks. Omit for all decks.' };
export const LIMIT = { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT, description: `Maximum cards to return (1–${MAX_LIMIT}, default ${DEFAULT_LIMIT}).` };
const CARD_SHAPE = 'Each card has studyItemId, prompt (the side the user is asked), answer (the side they must recall), decks (deck '
  + `paths such as "German/grammar"), state ("new" = never studied, "review" = studied before), due (ISO time, review cards only), `
  + `reps, lapses (times forgotten after being learned), revision (the card's version: it changes whenever the card is reviewed or edited) and next: for each rating (again, hard, good, easy), when the card would `
  + `come back if the user rated it now in the Recall app, as in ("10m", "5h", "3d") and due (UTC time). Sides are raw Markdown (may contain code, tables, formulas or image `
  + `embeds such as ![[file.png]]; do not read image syntax aloud) and are cut at ${MAX_SIDE_CHARS} characters, with "…" and truncated: true.`;
const unlimited = (n: number) => Number.isFinite(n) ? n : null;
const round1 = (n: number) => Math.round(n * 10) / 10;

export const listDecks: McpTool = {
  name: 'list_decks',
  title: 'List decks',
  description: 'Lists the user\'s Recall flashcard decks as a tree. Each deck has an id, a name, totalItems (cards in the deck '
    + 'and its subdecks), dueItems (cards due for review now) and newItems (never-reviewed cards), plus its child decks. '
    + 'Use it to see what the user can study and how much is due, and to get the deck id that the other tools take as deckId. Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'List decks', ...READ_ONLY },
  async call(service, args) {
    onlyKeys(args, []);
    return json({ decks: await service.query(c => c.getDeckTree.execute()) });
  },
};

export const getDueCards: McpTool = {
  name: 'get_due_cards',
  title: 'Get due cards',
  description: 'Returns the cards the user should study now, as their Recall review queue would: due review cards first (most '
    + 'overdue first), then new cards, both capped by what today\'s daily limits still allow. Also returns reviewsDue (review '
    + 'cards due now), newCardsDue (unseen cards waiting), reviewsLeftToday and newLeftToday (remaining daily allowance; null = '
    + `no limit), and deck (the deck path, or null). ${CARD_SHAPE} Use it to decide what to practise or quiz next. Only reads: `
    + 'it does not count as studying, change any schedule or use up daily limits. Quizzing the user here does not record a review.',
  inputSchema: { type: 'object', properties: { deckId: DECK_ID, limit: LIMIT }, additionalProperties: false },
  annotations: { title: 'Get due cards', ...READ_ONLY },
  async call(service, args) {
    onlyKeys(args, ['deckId', 'limit']);
    const deckId = deckArg(args), limit = limitArg(args);
    return json(await service.query(async c => {
      const decks = await DeckIndex.load(c);
      const { deck } = deckFilter(decks, deckId);
      const { newLeft, reviewLeft } = await service.allowance(c);
      const now = new Date();
      const due = await c.getDueStudyItems.execute(now, deckId);
      const reviews = due.filter(v => v.reps > 0).sort((a, b) => a.due.getTime() - b.due.getTime());
      const fresh = due.filter(v => v.reps === 0);
      const queue = [...reviews.slice(0, Math.min(reviews.length, reviewLeft)), ...fresh.slice(0, Math.min(fresh.length, newLeft))];
      return {
        deck, reviewsDue: reviews.length, newCardsDue: fresh.length,
        reviewsLeftToday: unlimited(reviewLeft), newLeftToday: unlimited(newLeft),
        cards: queue.slice(0, limit).map(v => cardView(v, decks.decksOf(v.studyItemId), nextPreview(c.scheduler, memoryState(v), now), service.revisionOf(v.studyItemId))),
      };
    }));
  },
};

export const getLeeches: McpTool = {
  name: 'get_leeches',
  title: 'Get leeches',
  description: 'Returns the user\'s leeches: cards forgotten at least threshold times after being learned (lapses ≥ threshold, '
    + `the server's leech setting), most lapses first. Also returns threshold, total (leeches in scope) and deck. ${CARD_SHAPE} `
    + 'Use it to find chronic problem cards worth explaining differently or practising in context. Read-only.',
  inputSchema: { type: 'object', properties: { deckId: DECK_ID, limit: LIMIT }, additionalProperties: false },
  annotations: { title: 'Get leeches', ...READ_ONLY },
  async call(service, args) {
    onlyKeys(args, ['deckId', 'limit']);
    const deckId = deckArg(args), limit = limitArg(args);
    const threshold = service.settings.leechThreshold;
    return json(await service.query(async c => {
      const decks = await DeckIndex.load(c);
      const { deck, allows } = deckFilter(decks, deckId);
      const leeches = (await c.getLeeches.execute(threshold)).filter(l => allows(l.studyItemId));
      const cards = [];
      const now = new Date();
      for (const leech of leeches.slice(0, limit)) {
        const item = await c.studyItemRepository.findById(new StudyItemId(leech.studyItemId));
        if (!item) continue;
        cards.push(cardView({ ...leech, due: item.memoryState.due }, decks.decksOf(leech.studyItemId), nextPreview(c.scheduler, item.memoryState, now), service.revisionOf(leech.studyItemId)));
      }
      return { deck, threshold, total: leeches.length, cards };
    }));
  },
};

export const getStudyStats: McpTool = {
  name: 'get_study_stats',
  title: 'Get study stats',
  description: 'Returns overall study statistics across all decks: totalItems, dueNow (cards due, including unseen new cards), '
    + 'newItems (never studied), learningItems (1–2 reviews), matureItems (3+ reviews), reviewsToday, and the remaining daily '
    + 'allowance newLeftToday and reviewsLeftToday (null = no limit). Use it for a progress summary; use list_decks for per-deck counts. Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'Get study stats', ...READ_ONLY },
  async call(service, args) {
    onlyKeys(args, []);
    return json(await service.query(async c => {
      const { newLeft, reviewLeft } = await service.allowance(c);
      return { ...await c.getStudyStats.execute(), newLeftToday: unlimited(newLeft), reviewsLeftToday: unlimited(reviewLeft) };
    }));
  },
};

export const searchCards: McpTool = {
  name: 'search_cards',
  title: 'Search cards',
  description: 'Finds the user\'s cards whose front (sideA) or back (sideB) contains the given text, ignoring case, accents and '
    + 'line breaks (plain substring match, not semantic; try a shorter word or another form if nothing matches). Returns query, '
    + 'total (matching cards in scope), deck and cards in vault order. Each card has sideA and sideB (raw Markdown, cut at '
    + `${MAX_SIDE_CHARS} characters with "…" and truncated: true), decks (deck paths) and directions: one entry per direction the `
    + 'user studies, with studyItemId, prompt ("sideA" or "sideB": the side shown as the question), state ("new" or "review"), '
    + 'due (review only), lapses, revision and next (per rating: in and due, if rated now). Use it to check whether the user already has a card on a word or topic. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 2, maxLength: 200, description: 'Text to look for (at least 2 characters), e.g. "Schmetterling" or "closure".' },
      deckId: DECK_ID, limit: LIMIT,
    },
    required: ['query'], additionalProperties: false,
  },
  annotations: { title: 'Search cards', ...READ_ONLY },
  async call(service, args) {
    onlyKeys(args, ['query', 'deckId', 'limit']);
    const query = args.query;
    if (typeof query !== 'string' || query.length > 200 || [...foldText(query)].length < 2) {
      throw new ToolInputError('query must be a string of 2–200 characters (not counting accents and spaces)');
    }
    const deckId = deckArg(args), limit = limitArg(args);
    return json(await service.query(async c => {
      const decks = await DeckIndex.load(c);
      const { deck, allows } = deckFilter(decks, deckId);
      const cards = [];
      const now = new Date();
      let total = 0;
      for (const concept of await c.conceptRepository.findContaining(query)) {
        const items = await c.studyItemRepository.findByConceptId(concept.id);
        if (deckId !== undefined && !items.some(i => allows(i.id.value))) continue;
        if (total++ >= limit) continue;
        const a = clip(concept.sideA.content), b = clip(concept.sideB.content);
        cards.push({
          sideA: a.text, sideB: b.text,
          decks: [...new Set(items.flatMap(i => decks.decksOf(i.id.value)))],
          directions: items.map(i => ({
            studyItemId: i.id.value, prompt: i.direction === Direction.AtoB ? 'sideA' : 'sideB',
            state: i.memoryState.reps === 0 ? 'new' : 'review',
            ...(i.memoryState.reps > 0 ? { due: i.memoryState.due.toISOString() } : {}), lapses: i.memoryState.lapses,
            revision: service.revisionOf(i.id.value), next: nextPreview(c.scheduler, i.memoryState, now),
          })),
          ...(a.cut || b.cut ? { truncated: true } : {}),
        });
      }
      return { query, deck, total, cards };
    }));
  },
};

export const getWeakCards: McpTool = {
  name: 'get_weak_cards',
  title: 'Get weak cards',
  description: 'Returns studied cards the user is shaky on, shakiest first: those with "Again" ratings in the last `days` days, '
    + 'forgotten after being learned (lapses), or rated hard by the scheduler (FSRS difficulty ≥ 7 of 10). Ranked by score = '
    + '3 × recentAgain + 2 × lapses + (difficulty − 5, if positive) + 1 if the memory is fragile (stability under 2 days). Unlike '
    + 'get_leeches it also catches recent trouble, and unlike get_due_cards it ignores whether the card is due. Each card adds '
    + `recentAgain, difficulty, lastReview and score to the usual fields. ${CARD_SHAPE} Also returns days, total and deck. `
    + 'Use it to steer practice toward what the user keeps getting wrong. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      deckId: DECK_ID, limit: LIMIT,
      days: { type: 'integer', minimum: 1, maximum: 90, default: 30, description: 'Window for counting recent "Again" ratings, in days (1–90, default 30).' },
    },
    additionalProperties: false,
  },
  annotations: { title: 'Get weak cards', ...READ_ONLY },
  async call(service, args) {
    onlyKeys(args, ['deckId', 'limit', 'days']);
    const deckId = deckArg(args), limit = limitArg(args), days = intArg(args, 'days', 1, 90, 30);
    return json(await service.query(async c => {
      const decks = await DeckIndex.load(c);
      const { deck, allows } = deckFilter(decks, deckId);
      const now = new Date();
      const weak = (await c.getWeakStudyItems.execute(now, days)).filter(w => allows(w.studyItemId));
      const cards = [];
      for (const w of weak) {
        if (cards.length >= limit) break;
        const concept = await c.conceptRepository.findById(new ConceptId(w.conceptId));
        if (!concept) continue;
        cards.push({
          ...cardView({ ...w, sideA: concept.sideA.content, sideB: concept.sideB.content }, decks.decksOf(w.studyItemId), nextPreview(c.scheduler, memoryState(w), now), service.revisionOf(w.studyItemId)),
          recentAgain: w.recentAgain, difficulty: round1(w.difficulty), lastReview: w.lastReview?.toISOString() ?? null, score: round1(w.score),
        });
      }
      return { deck, days, total: weak.length, cards };
    }));
  },
};

export const RECALL_TOOLS: readonly McpTool[] = [listDecks, getDueCards, getWeakCards, getLeeches, searchCards, getStudyStats];
