import { ApiError, type RecallService } from './service';
import { Directionality } from '../context/concept/domain/directionality';
import { foldText } from '../context/concept/domain/text-match';

export type ProposalStatus = 'pending' | 'accepted' | 'dismissed';
export const PROPOSAL_STATUSES: readonly ProposalStatus[] = ['pending', 'accepted', 'dismissed'];
export const MAX_PROPOSAL_SIDE = 1000;
export const MAX_PROPOSAL_CONTEXT = 1000;

/** A proposed card, as the private API returns it (`GET /api/v1/proposals`). Times are ISO strings. */
export interface CardProposal {
  id: number;
  sideA: string;
  sideB: string;
  directionality: Directionality;
  /** Suggested tag/deck path without "#", e.g. "german/grammar"; null if none. */
  deck: string | null;
  /** Why it was proposed (e.g. "confused der/die Katze"); null if none. */
  context: string | null;
  status: ProposalStatus;
  /** Who proposed it ('mcp'). */
  origin: string;
  createdAt: string;
  decidedAt: string | null;
  /** Vault note the plugin wrote the card into, if it said so when accepting. */
  notePath: string | null;
}

export interface ProposalInput { sideA: string; sideB: string; directionality: Directionality; deck: string | null; context: string | null }

type Row = Record<string, unknown>;
const toProposal = (r: Row): CardProposal => ({
  id: Number(r.id), sideA: r.side_a as string, sideB: r.side_b as string, directionality: r.directionality as Directionality,
  deck: (r.deck ?? null) as string | null, context: (r.context ?? null) as string | null, status: r.status as ProposalStatus,
  origin: r.origin as string, createdAt: new Date(r.created_at as number).toISOString(),
  decidedAt: r.decided_at === null ? null : new Date(r.decided_at as number).toISOString(), notePath: (r.note_path ?? null) as string | null,
});

/**
 * Validates a proposal: each side one line of 1–1000 characters without "::" (so the plugin can
 * write it as an inline card), a known directionality, an optional tag-like deck (no spaces, "#" or
 * commas; a leading "#" is dropped) and optional context of up to 1000 characters.
 */
export function proposalInput(raw: { sideA: unknown; sideB: unknown; directionality: unknown; deck?: unknown; context?: unknown }): ProposalInput {
  const side = (value: unknown, name: string) => {
    if (typeof value !== 'string') throw new ApiError(400, `${name} must be a string`);
    const text = value.trim();
    if (!text.length || text.length > MAX_PROPOSAL_SIDE) throw new ApiError(400, `${name} must have 1–${MAX_PROPOSAL_SIDE} characters`);
    if (/[\r\n]/.test(text)) throw new ApiError(400, `${name} must be a single line`);
    if (text.includes('::')) throw new ApiError(400, `${name} must not contain "::" (it separates the sides of a card)`);
    return text;
  };
  const sideA = side(raw.sideA, 'sideA'), sideB = side(raw.sideB, 'sideB');
  if (!Object.values(Directionality).includes(raw.directionality as Directionality)) throw new ApiError(400, 'directionality must be "unidirectional" or "bidirectional"');
  let deck: string | null = null;
  if (raw.deck !== undefined && raw.deck !== null) {
    if (typeof raw.deck !== 'string') throw new ApiError(400, 'deck must be a string');
    deck = raw.deck.trim().replace(/^#/, '');
    if (!deck.length || deck.length > 200 || /[\s#,]/.test(deck) || deck.startsWith('/') || deck.endsWith('/') || deck.includes('//')) {
      throw new ApiError(400, 'deck must be a tag path such as "german/grammar" (no spaces, "#" or commas)');
    }
  }
  let context: string | null = null;
  if (raw.context !== undefined && raw.context !== null) {
    if (typeof raw.context !== 'string' || raw.context.length > MAX_PROPOSAL_CONTEXT) throw new ApiError(400, `context must be a string of up to ${MAX_PROPOSAL_CONTEXT} characters`);
    context = raw.context.trim() || null;
  }
  return { sideA, sideB, directionality: raw.directionality as Directionality, deck, context };
}

const sameSides = (a1: string, b1: string, a2: string, b2: string) => {
  const [fa1, fb1, fa2, fb2] = [a1, b1, a2, b2].map(foldText);
  return (fa1 === fa2 && fb1 === fb2) || (fa1 === fb2 && fb1 === fa2);
};

/**
 * Card proposals: an inbox in the backend. A proposal never becomes a card by itself; the owner
 * accepts it in Obsidian, the plugin writes the card into a note, and publishing that note creates
 * the card as usual. The vault stays the only source of cards.
 */
export class CardProposals {
  constructor(private readonly service: RecallService) {}
  private get db() { return this.service.db; }

  /**
   * Stores a pending proposal. Idempotent: a pending proposal with the same sides (ignoring case,
   * accents, spacing and order) is returned instead (`duplicate: true`). A proposal for a card that
   * already exists is refused (409) with that card's study item ids.
   */
  propose(input: ProposalInput, origin: string): Promise<{ proposal: CardProposal; duplicate: boolean }> {
    return this.db.transaction(async () => {
      const c = this.service.container;
      for (const concept of await c.conceptRepository.findContaining(input.sideA)) {
        if (!sameSides(concept.sideA.content, concept.sideB.content, input.sideA, input.sideB)) continue;
        const items = (await c.studyItemRepository.findByConceptId(concept.id)).map(i => i.id.value);
        throw new ApiError(409, `That card already exists (studyItemId ${items.join(', ')})`);
      }
      for (const row of this.db.stmt("SELECT * FROM card_proposals WHERE status='pending' ORDER BY id").all()) {
        if (sameSides(row.side_a as string, row.side_b as string, input.sideA, input.sideB)) return { proposal: toProposal(row), duplicate: true };
      }
      const row = this.db.stmt(`INSERT INTO card_proposals (side_a, side_b, directionality, deck, context, status, origin, created_at)
        VALUES (?,?,?,?,?,'pending',?,?) RETURNING *`).get(input.sideA, input.sideB, input.directionality, input.deck, input.context, origin, Date.now())!;
      return { proposal: toProposal(row), duplicate: false };
    });
  }

  /** Oldest first. `status` undefined = all. */
  list(status?: ProposalStatus): Promise<CardProposal[]> {
    return this.db.transaction(async () => (status
      ? this.db.stmt('SELECT * FROM card_proposals WHERE status=? ORDER BY id').all(status)
      : this.db.stmt('SELECT * FROM card_proposals ORDER BY id').all()).map(toProposal));
  }

  /**
   * Accepts or dismisses a pending proposal. Idempotent: deciding the same way again returns the
   * proposal unchanged (the first `notePath` is kept); the opposite decision is a 409.
   */
  decide(id: number, decision: 'accepted' | 'dismissed', notePath: string | null): Promise<CardProposal> {
    return this.db.transaction(async () => {
      const row = this.db.stmt('SELECT * FROM card_proposals WHERE id=?').get(id);
      if (!row) throw new ApiError(404, 'Proposal not found');
      if (row.status === decision) return toProposal(row);
      if (row.status !== 'pending') throw new ApiError(409, `Proposal was already ${row.status as string}`);
      return toProposal(this.db.stmt('UPDATE card_proposals SET status=?, decided_at=?, note_path=? WHERE id=? RETURNING *')
        .get(decision, Date.now(), decision === 'accepted' ? notePath : null, id)!);
    });
  }
}

/** Body of `POST /api/v1/proposals/accept` and `/dismiss`: `{id, notePath?}`. */
export function decisionBody(body: Record<string, unknown>, accepting: boolean): { id: number; notePath: string | null } {
  const id = body.id;
  if (!Number.isSafeInteger(id) || (id as number) < 1) throw new ApiError(400, 'id must be a proposal id');
  let notePath: string | null = null;
  if (accepting && body.notePath !== undefined && body.notePath !== null) {
    if (typeof body.notePath !== 'string' || !body.notePath.length || body.notePath.length > 1024) throw new ApiError(400, 'Invalid notePath');
    notePath = body.notePath;
  }
  return { id: id as number, notePath };
}
