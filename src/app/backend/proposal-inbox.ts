import type { CardProposal, StudyClient, StudySettings, TagListing } from './study-client';

/**
 * Accepted card proposals are written into the vault, never created on the backend directly.
 *
 * A deck comes from a note's frontmatter tags and applies to every card of that note, so one note
 * cannot hold cards for different decks. Each deck gets its own inbox note inside the inbox folder:
 * `<folder>/<deck path>.md` (deck "German/vocabulary" → `Recall inbox/German/vocabulary.md`) whose
 * frontmatter carries exactly that tag. Cards without a deck go to `<folder>/No deck.md` (no tags;
 * tags cannot contain spaces, so no deck maps to that name). Cards are appended as inline list
 * items: `- A :: B` (one direction) or `- A ::: B` (both directions).
 */

export type CardDirectionality = CardProposal['directionality'];
export interface CardDraft { sideA: string; sideB: string; directionality: CardDirectionality; deck: string | null }

export const NO_DECK_NOTE = 'No deck';

/** Obsidian tag characters (letters, digits, `_`, `-`), nested with `/`; not only digits. */
const TAG_PATH = /^[\p{L}\p{N}_-]+(\/[\p{L}\p{N}_-]+)*$/u;

export function isDeckTag(deck: string): boolean {
  return TAG_PATH.test(deck) && !/^[\d/]+$/.test(deck);
}

/** Why this draft cannot be written as an inline card, or null. */
export function draftProblem(draft: CardDraft): string | null {
  for (const [name, side] of [['Side A', draft.sideA], ['Side B', draft.sideB]] as const) {
    if (!side.trim()) return `${name} is empty.`;
    if (/[\r\n]/.test(side)) return `${name} must be a single line.`;
    if (side.includes('::')) return `${name} must not contain "::".`;
    if (side.includes('<!--')) return `${name} must not contain "<!--".`;
  }
  if (draft.deck !== null && !isDeckTag(draft.deck)) {
    return `"${draft.deck}" is not a valid tag: use letters, digits, "_", "-" and "/" (e.g. German/vocabulary).`;
  }
  return null;
}

/**
 * The card as a list item. Spaces around the separator keep a side ending in ":" from turning
 * "::" into ":::"; the parser trims both sides, and the list marker protects a side starting with "- ".
 */
export function cardLine(draft: CardDraft): string {
  const separator = draft.directionality === 'bidirectional' ? ':::' : '::';
  return `- ${draft.sideA.trim()} ${separator} ${draft.sideB.trim()}`;
}

export function inboxNotePath(folder: string, deck: string | null): string {
  return `${folder}/${deck ?? NO_DECK_NOTE}.md`;
}

const unlisted = (line: string) => line.trim().replace(/^[-*]\s+/, '');

/** Whether the note already has this card line (with or without its list marker). */
export function hasCardLine(content: string, line: string): boolean {
  const wanted = unlisted(line);
  return content.split(/\r?\n/).some(existing => unlisted(existing) === wanted);
}

export function newInboxNote(deck: string | null, line: string): string {
  return deck === null ? `${line}\n` : `---\ntags:\n  - ${deck}\n---\n\n${line}\n`;
}

/**
 * Appends the line, keeping the existing content byte for byte as its prefix. A blank line goes
 * first unless the note already ends with one or with an inline card, so the new card is never
 * read as part of a multiline card above it.
 */
export function appendCardLine(content: string, line: string): string {
  let out = content && !content.endsWith('\n') ? `${content}\n` : content;
  const last = content.split(/\r?\n/).reverse().find(text => text.trim());
  if (last !== undefined && !last.includes('::') && !/\n\s*\n$/.test(out)) out += '\n';
  return `${out}${line}\n`;
}

/** Tags written in the note's frontmatter (loosely: every word of it), without "#". */
function frontmatterWords(content: string): string[] {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1].split(/[\s,[\]"']+/).map(word => word.replace(/^#/, '')).filter(Boolean) : [];
}

/** Known tag paths: those of published notes and the followed ones. */
export interface DeckInfo { tags: TagListing | null; settings: Pick<StudySettings, 'flashcardTags'> | null }

/**
 * Tags are case-sensitive for decks ("german" and "German" are different decks) while ChatGPT
 * proposes paths loosely. Reuses the spelling of the longest known prefix: with "German" known,
 * "german/verbs" becomes "German/verbs".
 */
export function resolveDeck(deck: string | null, info: DeckInfo): string | null {
  if (deck === null) return null;
  const known = [...(info.tags?.tags.map(t => t.tag) ?? []), ...(info.settings?.flashcardTags ?? [])];
  if (known.includes(deck)) return deck;
  const parts = deck.split('/');
  for (let n = parts.length; n > 0; n--) {
    const prefix = parts.slice(0, n).join('/').toLowerCase();
    const match = known.find(tag => tag.toLowerCase() === prefix);
    if (match) return [match, ...parts.slice(n)].join('/');
  }
  return deck;
}

export interface DeckPlacement {
  /** A deck with this exact tag path already has notes. Null when unknown. */
  exists: boolean | null;
  /** Its cards are studied with the current tag filter. Null when unknown. */
  followed: boolean | null;
}

export function deckPlacement(deck: string | null, info: DeckInfo): DeckPlacement {
  const filter = info.settings?.flashcardTags ?? null;
  const followed = filter === null ? null
    : filter.length === 0 || (deck !== null && filter.some(tag => deck === tag || deck.startsWith(tag + '/')));
  const exists = deck === null || !info.tags ? null : info.tags.tags.some(t => t.tag === deck);
  return { exists, followed };
}

/** What the proposal becomes if accepted as is: its sides, with the deck spelled like the known tag. */
export function draftOf(proposal: CardProposal, info: DeckInfo): CardDraft {
  return { sideA: proposal.sideA, sideB: proposal.sideB, directionality: proposal.directionality, deck: resolveDeck(proposal.deck, info) };
}

/** A card written to the vault whose acceptance the backend has not confirmed yet. */
export interface WrittenCard { notePath: string; line: string; deck: string | null }
export interface ProposalJournal { load(): Record<string, WrittenCard>; save(entries: Record<string, WrittenCard>): void }

/** The only vault access of the plugin: create a note (and its folders), or rewrite one atomically. */
export interface InboxVault {
  /** Null when there is no note at that path. */
  read(path: string): Promise<string | null>;
  /** Creates the note and any missing parent folders; fails if it exists. */
  create(path: string, content: string): Promise<void>;
  /** Atomic read-modify-write of an existing note. */
  process(path: string, change: (content: string) => string): Promise<void>;
}

export type ProposalApi = Pick<StudyClient, 'getProposals' | 'acceptProposal' | 'dismissProposal'>;

/** `gone`: the proposal is no longer pending (decided elsewhere or unknown); refresh the list. */
export class ProposalError extends Error {
  constructor(message: string, readonly gone = false) { super(message); }
}

function status(error: unknown): number | undefined {
  const value = (error as { status?: unknown })?.status;
  return typeof value === 'number' ? value : undefined;
}
const message = (error: unknown) => (error as Error)?.message ?? String(error);

/**
 * Accepts and dismisses proposals. Accepting writes first and tells the backend second; the written
 * card is journaled before the write, so a crash or a failed request is retried with the same note
 * and line, and a line already in the note is never appended twice.
 */
export class ProposalInbox {
  private tail: Promise<unknown> = Promise.resolve();
  private written = new Map<number, WrittenCard>();

  constructor(
    private readonly api: ProposalApi,
    private readonly vault: InboxVault,
    private readonly folder: () => string,
    private readonly journal?: ProposalJournal,
  ) {
    for (const [id, entry] of Object.entries(journal?.load() ?? {})) {
      if (!Number.isSafeInteger(Number(id)) || typeof entry?.notePath !== 'string' || typeof entry.line !== 'string'
        || (entry.deck !== null && typeof entry.deck !== 'string')) continue;
      this.written.set(Number(id), entry);
    }
  }

  get inboxFolder(): string { return this.folder(); }

  /** The card written for this proposal and not confirmed yet, if any. */
  pendingWrite(id: number): WrittenCard | null { return this.written.get(id) ?? null; }

  /** Drops journal entries of proposals that are no longer pending (decided, possibly elsewhere). */
  forget(pendingIds: ReadonlySet<number>): void {
    let changed = false;
    for (const id of [...this.written.keys()]) if (!pendingIds.has(id)) { this.written.delete(id); changed = true; }
    if (changed) this.save();
  }

  private save(): void {
    this.journal?.save(Object.fromEntries([...this.written].map(([id, entry]) => [String(id), entry])));
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }

  /**
   * Writes the card into its inbox note, then accepts the proposal with that note path. A card
   * already written for this proposal (journaled) is reused as is, whatever `draft` says.
   * Resolves with `appended: false` when the line was already in the note.
   */
  accept(proposal: CardProposal, draft: CardDraft): Promise<{ notePath: string; appended: boolean }> {
    return this.serialize(async () => {
      let entry = this.written.get(proposal.id);
      if (!entry) {
        const problem = draftProblem(draft);
        if (problem) throw new ProposalError(problem);
        // Narrow the window in which a card is written for a proposal decided elsewhere.
        const pending = await this.api.getProposals();
        if (!pending.some(p => p.id === proposal.id)) throw new ProposalError('This proposal is no longer pending. Nothing was written.', true);
        entry = { notePath: inboxNotePath(this.folder(), draft.deck), line: cardLine(draft), deck: draft.deck };
        this.written.set(proposal.id, entry);
        this.save(); // Before writing: a crash after the write still knows which line it was.
      }
      let appended: boolean;
      try {
        appended = await this.writeLine(entry);
      } catch (error) {
        const content = await this.vault.read(entry.notePath).catch(() => null);
        if (content === null || !hasCardLine(content, entry.line)) { this.written.delete(proposal.id); this.save(); }
        throw new ProposalError(`Could not write to ${entry.notePath}: ${message(error)}`);
      }
      try {
        await this.api.acceptProposal(proposal.id, entry.notePath);
      } catch (error) {
        const code = status(error);
        if (code === 404 || code === 409) {
          this.written.delete(proposal.id); this.save();
          const reason = code === 404 ? 'no longer exists' : 'was already dismissed';
          throw new ProposalError(`The proposal ${reason}, but the card is in ${entry.notePath}. Remove that line if you do not want the card.`, true);
        }
        throw new ProposalError(`The card is in ${entry.notePath}, but the backend did not confirm: ${message(error)} Accept again to retry; the card will not be added twice.`);
      }
      this.written.delete(proposal.id);
      this.save();
      return { notePath: entry.notePath, appended };
    });
  }

  /** Only tells the backend. A card already written for it stays in its note. */
  dismiss(proposal: CardProposal): Promise<{ leftIn: string | null }> {
    return this.serialize(async () => {
      try {
        await this.api.dismissProposal(proposal.id);
      } catch (error) {
        const code = status(error);
        if (code === 404) throw new ProposalError('This proposal no longer exists.', true);
        if (code === 409) throw new ProposalError('This proposal was already accepted.', true);
        throw new ProposalError(`Could not dismiss: ${message(error)}`);
      }
      const leftIn = this.written.get(proposal.id)?.notePath ?? null;
      if (this.written.delete(proposal.id)) this.save();
      return { leftIn };
    });
  }

  /** True when appended; false when the line was already there. */
  private async writeLine(entry: WrittenCard): Promise<boolean> {
    const existing = await this.vault.read(entry.notePath);
    if (existing === null) {
      await this.vault.create(entry.notePath, newInboxNote(entry.deck, entry.line));
      return true;
    }
    if (hasCardLine(existing, entry.line)) return false;
    if (entry.deck !== null && !frontmatterWords(existing).includes(entry.deck)) {
      throw new Error(`its frontmatter does not have the tag ${entry.deck}, so the card would land in another deck. Restore the tag or move the note.`);
    }
    let appended = false;
    await this.vault.process(entry.notePath, content => {
      if (hasCardLine(content, entry.line)) return content;
      appended = true;
      return appendCardLine(content, entry.line);
    });
    return appended;
  }
}
