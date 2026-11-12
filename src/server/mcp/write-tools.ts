import { ApiError, type RecallService } from '../service';
import { Rating } from '../../context/study/domain/rating';
import { CORRECTION_WINDOW_MS, ReviewCorrections, type ChangeResult } from '../review-corrections';
import { CardProposals, PROPOSAL_STATUSES, proposalInput, type CardProposal, type ProposalStatus } from '../proposals';
import { clip, DeckIndex, minuteIso, untilText } from './card-views';
import { intArg, json, limitArg, LIMIT, onlyKeys, READ_ONLY, ToolInputError, type McpTool, type ToolAnnotations } from './tools';

/**
 * Write tools, exposed only with `RECALL_MCP_WRITE=true`. None claims `readOnlyHint`. None is
 * `destructiveHint`: recording a review and proposing a card only add data, and every correction
 * of a review is kept in an audit trail and can be reverted (`revert_review_change`), which is the
 * "not irreversible or difficult to reverse" case of OpenAI's definition. All are idempotent: the
 * same call with the same arguments has no further effect (see each description).
 */
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const RATINGS = Object.values(Rating) as string[];
const RATING = { type: 'string', enum: RATINGS, description: 'The rating: "again" (forgot), "hard", "good" or "easy".' };
const WINDOW_HOURS = CORRECTION_WINDOW_MS / 3_600_000;

type Args = Record<string, unknown>;
function ratingArg(args: Args): Rating {
  if (typeof args.rating !== 'string' || !RATINGS.includes(args.rating)) throw new ToolInputError('rating must be one of again, hard, good, easy');
  return args.rating as Rating;
}
function idArg(args: Args, name: string, what: string): number {
  const value = args[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new ToolInputError(`${name} must be the integer id of ${what}`);
  return value;
}
/** Business refusals from the service become tool errors the model can read. */
async function refusals<T>(work: () => Promise<T>, hint?: (e: ApiError) => string | undefined): Promise<T> {
  try { return await work(); }
  catch (e) {
    if (e instanceof ApiError) throw new ToolInputError(hint?.(e) ?? e.message);
    throw e;
  }
}
const prompt = (text: string | null) => text === null ? null : clip(text).text;

async function changeOutput(service: RecallService, corrections: ReviewCorrections, r: ChangeResult) {
  const now = new Date();
  const card = await service.query(c => corrections.cardText(c, r.studyItemId));
  return {
    changeId: r.changeId, reviewId: r.reviewId, studyItemId: r.studyItemId, prompt: prompt(card.prompt),
    action: r.action, from: r.from, to: r.to,
    ...(r.due ? { due: minuteIso(r.due), in: untilText(r.due, now) } : {}),
    ...(r.already ? { alreadyDone: true } : {}),
  };
}

export const recordReview: McpTool = {
  name: 'record_review',
  title: 'Record review',
  description: 'Records the user\'s rating of a card in Recall, exactly as rating it in the Recall app: it updates the card\'s schedule, '
    + 'counts toward today\'s daily limits and refreshes the card on the user\'s other devices. Use it ONLY after the user has actually '
    + 'answered the card\'s prompt and you have said the rating aloud to them (e.g. "that\'s a Good"); never for cards merely discussed '
    + 'or explained. Pass the studyItemId and revision of the card as returned by get_due_cards (or search_cards / get_weak_cards / '
    + 'get_leeches). The card must be due and within today\'s limits; otherwise the call fails with the reason. Returns reviewId (to '
    + 'correct it later), prompt, rating, due (UTC, to the minute) and in (e.g. "3d"): when the card comes back, and the card\'s new '
    + 'revision. Safe to retry: calling again with the same studyItemId, revision and rating returns the same result without recording '
    + 'twice; the same revision with a different rating is refused (use amend_review to change a rating).',
  inputSchema: {
    type: 'object',
    properties: {
      studyItemId: { type: 'string', description: 'The card\'s studyItemId, as returned by get_due_cards.' },
      rating: RATING,
      revision: { type: 'integer', minimum: 0, description: 'The card\'s revision exactly as returned with it by get_due_cards (or another card tool).' },
    },
    required: ['studyItemId', 'rating', 'revision'], additionalProperties: false,
  },
  annotations: { title: 'Record review', ...WRITE },
  async call(service, args) {
    onlyKeys(args, ['studyItemId', 'rating', 'revision']);
    const { studyItemId } = args;
    if (typeof studyItemId !== 'string' || !studyItemId.length || studyItemId.length > 256) throw new ToolInputError('studyItemId must be the studyItemId of a card');
    const rating = ratingArg(args);
    const revision = intArg(args, 'revision', 0, Number.MAX_SAFE_INTEGER, -1);
    if (revision < 0) throw new ToolInputError('revision is required: pass the card\'s revision from get_due_cards');
    // The receipt key is derived from the card and the revision the model saw: a retried call finds
    // the receipt of the first one (same result, nothing recorded twice); see docs/backend.md.
    const result = await refusals(() => service.review({ operationId: `mcp-review:${studyItemId}:${revision}`, studyItemId, rating, expectedRevision: revision }, 'mcp'),
      e => /already used for a different command/.test(e.message)
        ? `This card was already rated with another rating at revision ${revision}. To change that rating, find it with list_recent_reviews and use amend_review.`
        : e.status === 409 && /another device/.test(e.message)
          ? `${e.message.replace(/; refresh the queue$/, '')}. Call get_due_cards (or search_cards) again for the card's current state and revision.`
          : e.status === 404 ? 'That card no longer exists (its note was edited or deleted).' : undefined) as
      { reviewId: number | null; revision: number; due: string };
    const card = await service.query(c => new ReviewCorrections(service).cardText(c, studyItemId));
    const due = new Date(result.due);
    return json({ reviewId: result.reviewId, studyItemId, prompt: prompt(card.prompt), rating, due: minuteIso(due), in: untilText(due, new Date()), revision: result.revision });
  },
};

export const listRecentReviews: McpTool = {
  name: 'list_recent_reviews',
  title: 'List recent reviews',
  description: `Lists the user's latest reviews from any device (this conversation, the Android app, Obsidian), newest first, from the last `
    + `\`hours\` hours (1–${WINDOW_HOURS}, default ${WINDOW_HOURS}: only reviews from the last 2 days can be corrected). Each review has reviewId (what `
    + 'amend_review and remove_review take), studyItemId, prompt and answer of the card (null if the card was deleted since), rating, '
    + 'originalRating (only if the rating was corrected since), at (UTC, to the minute) and origin ("mcp" = recorded here, "android", '
    + '"obsidian", "api" = another client, "unknown" = recorded before origins were kept). Also returns changes: the corrections made in that '
    + 'window, newest first, each with changeId (what revert_review_change takes), reviewId, prompt, action ("amend", "remove" or "restore"), '
    + 'from and to (ratings), at, reverts (the change it undid, if any) and revertedBy (if it was undone). Use it to find the review to '
    + 'correct when the user says a rating was wrong. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      hours: { type: 'integer', minimum: 1, maximum: WINDOW_HOURS, default: WINDOW_HOURS, description: `How far back to look, in hours (1–${WINDOW_HOURS}, default ${WINDOW_HOURS}).` },
      limit: LIMIT,
    },
    additionalProperties: false,
  },
  annotations: { title: 'List recent reviews', ...READ_ONLY },
  async call(service, args) {
    onlyKeys(args, ['hours', 'limit']);
    const hours = intArg(args, 'hours', 1, WINDOW_HOURS, WINDOW_HOURS), limit = limitArg(args);
    const corrections = new ReviewCorrections(service);
    return json(await service.query(async c => {
      const since = new Date(Date.now() - hours * 3_600_000);
      const reviews = (await corrections.recent(c, since, limit)).map(({ entry, card, originalRating }) => ({
        reviewId: entry.id, studyItemId: entry.review.studyItemId.value, prompt: prompt(card.prompt), answer: prompt(card.answer),
        rating: entry.review.rating, ...(originalRating ? { originalRating } : {}),
        at: minuteIso(entry.review.timestamp), origin: entry.review.origin ?? 'unknown',
      }));
      const changes = (await corrections.changes(c, since, limit)).map(ch => ({
        changeId: ch.changeId, reviewId: ch.reviewId, prompt: prompt(ch.card.prompt), action: ch.action, from: ch.from, to: ch.to,
        at: minuteIso(ch.at), ...(ch.reverts !== null ? { reverts: ch.reverts } : {}), ...(ch.revertedBy !== null ? { revertedBy: ch.revertedBy } : {}),
      }));
      return { hours, reviews, changes };
    }));
  },
};

const CHANGE_SHAPE = 'Returns changeId (the audit entry; pass it to revert_review_change to undo this), reviewId, studyItemId, prompt, '
  + 'action, from and to (ratings; null where not applicable), and the card\'s new due (UTC, to the minute) and in ("now" if due again).';

export const amendReview: McpTool = {
  name: 'amend_review',
  title: 'Amend review',
  description: 'Changes the rating of a past review (e.g. the user says "that should have been Hard, not Easy"). The card\'s schedule is '
    + 'recomputed as if the new rating had been given at the time, including any later reviews of it. Only reviews from the last 2 days. '
    + 'Take reviewId from list_recent_reviews (or record_review) and confirm the card and the new rating with the user first. '
    + `${CHANGE_SHAPE} Recorded in an audit trail. Safe to retry: if the review already has that rating nothing changes (changeId null).`,
  inputSchema: {
    type: 'object',
    properties: { reviewId: { type: 'integer', minimum: 1, description: 'The reviewId from list_recent_reviews or record_review.' }, rating: RATING },
    required: ['reviewId', 'rating'], additionalProperties: false,
  },
  annotations: { title: 'Amend review', ...WRITE },
  async call(service, args) {
    onlyKeys(args, ['reviewId', 'rating']);
    const reviewId = idArg(args, 'reviewId', 'a review from list_recent_reviews'), rating = ratingArg(args);
    const corrections = new ReviewCorrections(service);
    return json(await changeOutput(service, corrections, await refusals(() => corrections.amend(reviewId, rating, 'mcp'))));
  },
};

export const removeReview: McpTool = {
  name: 'remove_review',
  title: 'Remove review',
  description: 'Deletes a review that should not have been recorded (e.g. rated the wrong card, or the user did not really answer). The '
    + 'card\'s schedule is recomputed as if that review had never happened (it may become due again) and, for a review made today, its '
    + 'daily allowance is given back. Only reviews from the last 2 days. Take reviewId from list_recent_reviews and confirm with the user '
    + `first. ${CHANGE_SHAPE} The removed review is kept in the audit trail and revert_review_change puts it back. Safe to retry: removing `
    + 'an already removed review returns that removal with alreadyDone: true.',
  inputSchema: {
    type: 'object',
    properties: { reviewId: { type: 'integer', minimum: 1, description: 'The reviewId from list_recent_reviews or record_review.' } },
    required: ['reviewId'], additionalProperties: false,
  },
  annotations: { title: 'Remove review', ...WRITE },
  async call(service, args) {
    onlyKeys(args, ['reviewId']);
    const reviewId = idArg(args, 'reviewId', 'a review from list_recent_reviews');
    const corrections = new ReviewCorrections(service);
    return json(await changeOutput(service, corrections, await refusals(() => corrections.remove(reviewId, 'mcp'))));
  },
};

export const revertReviewChange: McpTool = {
  name: 'revert_review_change',
  title: 'Revert review change',
  description: 'Undoes one correction from list_recent_reviews\' changes: an amend goes back to the previous rating, a removal puts the '
    + 'review back, a restore removes it again. The card is recomputed. Only for reviews from the last 2 days, and only the latest change '
    + `of a review (undo later ones first). ${CHANGE_SHAPE} The undo is itself a change (its reverts = the undone changeId). Safe to retry: `
    + 'reverting an already reverted change returns that revert with alreadyDone: true.',
  inputSchema: {
    type: 'object',
    properties: { changeId: { type: 'integer', minimum: 1, description: 'The changeId from list_recent_reviews (changes) or from amend_review / remove_review.' } },
    required: ['changeId'], additionalProperties: false,
  },
  annotations: { title: 'Revert review change', ...WRITE },
  async call(service, args) {
    onlyKeys(args, ['changeId']);
    const changeId = idArg(args, 'changeId', 'a change from list_recent_reviews');
    const corrections = new ReviewCorrections(service);
    return json(await changeOutput(service, corrections, await refusals(() => corrections.revert(changeId, 'mcp'))));
  },
};

const proposalView = (p: CardProposal) => ({
  proposalId: p.id, sideA: p.sideA, sideB: p.sideB, directionality: p.directionality, deck: p.deck,
  ...(p.context ? { context: p.context } : {}), status: p.status, createdAt: `${p.createdAt.slice(0, 16)}Z`,
});

export const proposeCard: McpTool = {
  name: 'propose_card',
  title: 'Propose card',
  description: 'Suggests a new flashcard for the user, e.g. for something they confused or did not know. It does NOT create a card: it goes '
    + 'to an inbox in Recall and only becomes a card if the user accepts it later in Obsidian (tell them so). sideA is the front (the '
    + 'question or the word), sideB the back (the answer); each one line, without "::". directionality "unidirectional" asks only sideA → '
    + 'sideB; "bidirectional" also asks sideB → sideA (good for vocabulary). deck is a suggested deck path like those of list_decks '
    + '("german/grammar"), context a short note for the user on why (e.g. "confused der and die Katze"). Check search_cards and '
    + 'list_card_proposals first to avoid duplicates. A card that already exists is refused. Returns the proposal (proposalId, sides, '
    + 'directionality, deck, context, status "pending", createdAt) and deckExists. Safe to retry: proposing the same sides again returns the '
    + 'pending proposal with duplicate: true.',
  inputSchema: {
    type: 'object',
    properties: {
      sideA: { type: 'string', minLength: 1, maxLength: 1000, description: 'Front: the question or term, one line.' },
      sideB: { type: 'string', minLength: 1, maxLength: 1000, description: 'Back: the answer, one line.' },
      directionality: { type: 'string', enum: ['unidirectional', 'bidirectional'], description: '"unidirectional" (sideA → sideB only) or "bidirectional" (both ways).' },
      deck: { type: 'string', maxLength: 200, description: 'Optional. Suggested deck path, e.g. "german/vocabulary".' },
      context: { type: 'string', maxLength: 1000, description: 'Optional. Why this card helps, for the user to read when deciding.' },
    },
    required: ['sideA', 'sideB', 'directionality'], additionalProperties: false,
  },
  annotations: { title: 'Propose card', ...WRITE },
  async call(service, args) {
    onlyKeys(args, ['sideA', 'sideB', 'directionality', 'deck', 'context']);
    const input = await refusals(async () => proposalInput(args as Parameters<typeof proposalInput>[0]));
    const { proposal, duplicate } = await refusals(() => new CardProposals(service).propose(input, 'mcp'),
      e => e.status === 409 ? `${e.message}. Do not propose it again.` : undefined);
    const deckExists = proposal.deck === null ? null : await service.query(async c => (await DeckIndex.load(c)).hasPath(proposal.deck!));
    return json({ ...proposalView(proposal), deckExists, ...(duplicate ? { duplicate: true } : {}) });
  },
};

export const listCardProposals: McpTool = {
  name: 'list_card_proposals',
  title: 'List card proposals',
  description: 'Lists cards proposed with propose_card, newest first: by default those still pending the user\'s decision in Obsidian '
    + '(status "accepted" or "dismissed" for decided ones, "all" for every one). Each has proposalId, sideA, sideB, directionality, deck, '
    + 'context, status and createdAt; also returns total. Use it before proposing, to avoid suggesting the same card twice. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: [...PROPOSAL_STATUSES, 'all'], default: 'pending', description: 'Which proposals: "pending" (default), "accepted", "dismissed" or "all".' },
      limit: LIMIT,
    },
    additionalProperties: false,
  },
  annotations: { title: 'List card proposals', ...READ_ONLY },
  async call(service, args) {
    onlyKeys(args, ['status', 'limit']);
    const status = args.status ?? 'pending';
    if (status !== 'all' && !PROPOSAL_STATUSES.includes(status as ProposalStatus)) throw new ToolInputError('status must be pending, accepted, dismissed or all');
    const limit = limitArg(args);
    const all = (await new CardProposals(service).list(status === 'all' ? undefined : status as ProposalStatus)).reverse();
    return json({ status, total: all.length, proposals: all.slice(0, limit).map(proposalView) });
  },
};

export const RECALL_WRITE_TOOLS: readonly McpTool[] = [recordReview, listRecentReviews, amendReview, removeReview, revertReviewChange, proposeCard, listCardProposals];
