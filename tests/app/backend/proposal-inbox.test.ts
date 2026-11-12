import { describe, expect, it, vi } from 'vitest';
import {
  ProposalError, ProposalInbox, appendCardLine, cardLine, deckPlacement, draftOf, draftProblem, hasCardLine, inboxNotePath,
  resolveDeck, type InboxVault, type ProposalJournal, type WrittenCard,
} from '../../../src/app/backend/proposal-inbox';
import { RemoteError } from '../../../src/app/backend/remote-client';
import type { CardProposal, TagListing } from '../../../src/app/backend/study-client';
import { MarkdownParser } from '../../../src/context/concept/infrastructure/markdown-parser';
import { FrontmatterParser } from '../../../src/context/concept/infrastructure/frontmatter-parser';

const proposal = (id: number, over: Partial<CardProposal> = {}): CardProposal => ({
  id, sideA: 'die Biene', sideB: 'the bee', directionality: 'bidirectional', deck: 'German/vocabulary', context: null,
  status: 'pending', origin: 'mcp', createdAt: '2026-11-12T08:00:00.000Z', decidedAt: null, notePath: null, ...over,
});
const draft = (p: CardProposal) => draftOf(p, { tags: null, settings: null });

/** In-memory vault: records every write so tests can prove nothing else was touched. */
class FakeVault implements InboxVault {
  files = new Map<string, string>();
  writes: string[] = [];
  failNextWrite = false;
  async read(path: string) { return this.files.get(path) ?? null; }
  async create(path: string, content: string) {
    if (this.failNextWrite) { this.failNextWrite = false; throw new Error('disk full'); }
    if (this.files.has(path)) throw new Error('File already exists.');
    this.files.set(path, content); this.writes.push(path);
  }
  async process(path: string, change: (content: string) => string) {
    if (this.failNextWrite) { this.failNextWrite = false; throw new Error('disk full'); }
    this.files.set(path, change(this.files.get(path)!)); this.writes.push(path);
  }
}

function setup(pending: CardProposal[], stored: Record<string, WrittenCard> = {}) {
  const vault = new FakeVault();
  let journal: Record<string, WrittenCard> = structuredClone(stored);
  const store: ProposalJournal = { load: () => structuredClone(journal), save: entries => { journal = structuredClone(entries); } };
  const api = {
    getProposals: vi.fn(async () => pending.filter(p => p.status === 'pending')),
    acceptProposal: vi.fn(async (id: number, notePath: string) => {
      const p = pending.find(x => x.id === id)!;
      p.status = 'accepted'; p.notePath = notePath;
      return { ...p };
    }),
    dismissProposal: vi.fn(async (id: number) => { const p = pending.find(x => x.id === id)!; p.status = 'dismissed'; return { ...p }; }),
  };
  const inbox = new ProposalInbox(api, vault, () => 'Recall inbox', store);
  return { vault, api, inbox, journal: () => journal };
}

/** What the backend would index from a note: its tags (deck) and its cards. */
function indexed(content: string) {
  return {
    tags: new FrontmatterParser().extractTags(content),
    cards: new MarkdownParser().parse(content, 'x.md').map(c => [c.sideA, c.sideB, c.directionality]),
  };
}

describe('card line and inbox note syntax', () => {
  it('writes inline list items the parser reads with the right directionality', () => {
    const both = cardLine({ sideA: 'die Biene', sideB: 'the bee', directionality: 'bidirectional', deck: null });
    const one = cardLine({ sideA: 'Hauptstadt von Spanien', sideB: 'Madrid', directionality: 'unidirectional', deck: null });
    expect(both).toBe('- die Biene ::: the bee');
    expect(one).toBe('- Hauptstadt von Spanien :: Madrid');
    expect(indexed(`${both}\n${one}\n`).cards).toEqual([
      ['die Biene', 'the bee', 'bidirectional'], ['Hauptstadt von Spanien', 'Madrid', 'unidirectional'],
    ]);
  });

  it('keeps a side ending or starting with ":" unidirectional, and a side starting with "- " intact', () => {
    const line = cardLine({ sideA: 'Note:', sideB: ':-) smile', directionality: 'unidirectional', deck: null });
    expect(indexed(line).cards).toEqual([['Note:', ':-) smile', 'unidirectional']]);
    expect(indexed(cardLine({ sideA: '- x', sideB: 'y', directionality: 'unidirectional', deck: null })).cards).toEqual([['- x', 'y', 'unidirectional']]);
  });

  it('places one note per deck, and cards without a deck in "No deck.md"', () => {
    expect(inboxNotePath('Recall inbox', 'German/vocabulary')).toBe('Recall inbox/German/vocabulary.md');
    expect(inboxNotePath('Recall inbox', null)).toBe('Recall inbox/No deck.md');
  });

  it('detects the line with or without its list marker', () => {
    expect(hasCardLine('---\ntags:\n  - X\n---\n\n- a :: b\n', '- a :: b')).toBe(true);
    expect(hasCardLine('a :: b', '- a :: b')).toBe(true);
    expect(hasCardLine('- a :: bc', '- a :: b')).toBe(false);
  });

  it('separates an appended card from a multiline card above it', () => {
    const multiline = 'Question\n?\nAnswer';
    const content = appendCardLine(multiline, '- a :: b');
    expect(content).toBe('Question\n?\nAnswer\n\n- a :: b\n');
    expect(indexed(content).cards).toEqual([['Question', 'Answer', 'unidirectional'], ['a', 'b', 'unidirectional']]);
    expect(appendCardLine('- x :: y', '- a :: b')).toBe('- x :: y\n- a :: b\n');
    expect(appendCardLine('', '- a :: b')).toBe('- a :: b\n');
  });

  it('only appends: the existing content stays an exact prefix', () => {
    for (const content of ['- x :: y\n', '- x :: y\n\n\n', 'text', 'text\r\n', 'Answer\n\n', '  \n']) {
      const out = appendCardLine(content, '- a :: b');
      expect(out.startsWith(content)).toBe(true);
      expect(out.endsWith('- a :: b\n')).toBe(true);
    }
  });

  it('rejects drafts that cannot be one inline card', () => {
    const ok = { sideA: 'a', sideB: 'b', directionality: 'unidirectional' as const, deck: 'German' };
    expect(draftProblem(ok)).toBeNull();
    expect(draftProblem({ ...ok, sideA: ' ' })).toMatch(/empty/);
    expect(draftProblem({ ...ok, sideB: 'x\ny' })).toMatch(/single line/);
    expect(draftProblem({ ...ok, sideB: 'x :: y' })).toMatch(/::/);
    expect(draftProblem({ ...ok, deck: 'has space' })).toMatch(/not a valid tag/);
    expect(draftProblem({ ...ok, deck: '2024' })).toMatch(/not a valid tag/);
    expect(draftProblem({ ...ok, deck: 'Deutsch/Wörter_1' })).toBeNull();
  });
});

describe('deck resolution', () => {
  const tags: TagListing = {
    tags: [{ tag: 'German', notes: 2, cards: 3, selected: true, followed: true }, { tag: 'German/vocabulary', notes: 1, cards: 2, selected: false, followed: true }],
    untagged: { notes: 0, cards: 0, followed: false },
  };
  const info = { tags, settings: { flashcardTags: ['German', 'Philosophy'] } };

  it('spells a proposed deck like the known tag (decks are case-sensitive)', () => {
    expect(resolveDeck('german/vocabulary', info)).toBe('German/vocabulary');
    expect(resolveDeck('german/verbs', info)).toBe('German/verbs');
    expect(resolveDeck('philosophy/ethics', info)).toBe('Philosophy/ethics');
    expect(resolveDeck('Kafka', info)).toBe('Kafka');
    expect(resolveDeck(null, info)).toBeNull();
    expect(resolveDeck('german', { tags: null, settings: null })).toBe('german');
  });

  it('tells whether the deck exists and is followed', () => {
    expect(deckPlacement('German/vocabulary', info)).toEqual({ exists: true, followed: true });
    expect(deckPlacement('German/verbs', info)).toEqual({ exists: false, followed: true });
    expect(deckPlacement('Kafka', info)).toEqual({ exists: false, followed: false });
    expect(deckPlacement(null, info)).toEqual({ exists: null, followed: false });
    expect(deckPlacement(null, { tags, settings: { flashcardTags: [] } })).toEqual({ exists: null, followed: true });
    expect(deckPlacement('Kafka', { tags: null, settings: null })).toEqual({ exists: null, followed: null });
  });
});

describe('ProposalInbox.accept', () => {
  it('creates the deck notes and accepts with their paths: two decks, one card of each directionality', async () => {
    const german = proposal(1);
    const capital = proposal(2, { sideA: 'Capital of Spain', sideB: 'Madrid', directionality: 'unidirectional', deck: 'Geography/capitals' });
    const { vault, api, inbox, journal } = setup([german, capital]);
    expect(await inbox.accept(german, draft(german))).toEqual({ notePath: 'Recall inbox/German/vocabulary.md', appended: true });
    expect(await inbox.accept(capital, draft(capital))).toEqual({ notePath: 'Recall inbox/Geography/capitals.md', appended: true });

    const germanNote = vault.files.get('Recall inbox/German/vocabulary.md')!;
    const capitalNote = vault.files.get('Recall inbox/Geography/capitals.md')!;
    expect(germanNote).toBe('---\ntags:\n  - German/vocabulary\n---\n\n- die Biene ::: the bee\n');
    expect(capitalNote).toBe('---\ntags:\n  - Geography/capitals\n---\n\n- Capital of Spain :: Madrid\n');
    expect(indexed(germanNote)).toEqual({ tags: ['German/vocabulary'], cards: [['die Biene', 'the bee', 'bidirectional']] });
    expect(indexed(capitalNote)).toEqual({ tags: ['Geography/capitals'], cards: [['Capital of Spain', 'Madrid', 'unidirectional']] });
    expect(api.acceptProposal.mock.calls).toEqual([[1, 'Recall inbox/German/vocabulary.md'], [2, 'Recall inbox/Geography/capitals.md']]);
    expect(vault.writes).toEqual(['Recall inbox/German/vocabulary.md', 'Recall inbox/Geography/capitals.md']);
    expect(journal()).toEqual({});
  });

  it('appends to an existing deck note, keeping what is there', async () => {
    const p = proposal(3, { sideA: 'die Ameise', sideB: 'the ant' });
    const { vault, inbox } = setup([p]);
    vault.files.set('Recall inbox/German/vocabulary.md', '---\ntags:\n  - German/vocabulary\n---\n\n- die Biene ::: the bee\n');
    await inbox.accept(p, draft(p));
    const note = vault.files.get('Recall inbox/German/vocabulary.md')!;
    expect(note).toBe('---\ntags:\n  - German/vocabulary\n---\n\n- die Biene ::: the bee\n- die Ameise ::: the ant\n');
    expect(indexed(note).cards).toHaveLength(2);
  });

  it('writes a card without a deck into "No deck.md", untagged', async () => {
    const p = proposal(4, { deck: null, directionality: 'unidirectional' });
    const { vault, api, inbox } = setup([p]);
    await inbox.accept(p, draft(p));
    expect(vault.files.get('Recall inbox/No deck.md')).toBe('- die Biene :: the bee\n');
    expect(indexed(vault.files.get('Recall inbox/No deck.md')!).tags).toEqual([]);
    expect(api.acceptProposal).toHaveBeenCalledWith(4, 'Recall inbox/No deck.md');
  });

  it('uses the edited draft', async () => {
    const p = proposal(5);
    const { vault, inbox } = setup([p]);
    await inbox.accept(p, { sideA: 'die Honigbiene', sideB: 'the honeybee', directionality: 'unidirectional', deck: 'German' });
    expect(vault.files.get('Recall inbox/German.md')).toBe('---\ntags:\n  - German\n---\n\n- die Honigbiene :: the honeybee\n');
  });

  it('after a failed accept call, retrying does not duplicate the line and keeps the written card', async () => {
    const p = proposal(6);
    const { vault, api, inbox, journal } = setup([p]);
    api.acceptProposal.mockRejectedValueOnce(new Error('Backend connection timed out.'));
    const failed = inbox.accept(p, draft(p));
    await expect(failed).rejects.toThrow(/is in Recall inbox\/German\/vocabulary\.md, but the backend did not confirm/);
    expect(inbox.pendingWrite(6)).toEqual({ notePath: 'Recall inbox/German/vocabulary.md', line: '- die Biene ::: the bee', deck: 'German/vocabulary' });
    expect(journal()['6']).toBeDefined();

    // A retry, even with another draft, reuses the journaled card.
    const retried = await inbox.accept(p, { ...draft(p), sideB: 'something else' });
    expect(retried).toEqual({ notePath: 'Recall inbox/German/vocabulary.md', appended: false });
    expect(vault.files.get('Recall inbox/German/vocabulary.md')!.match(/die Biene/g)).toHaveLength(1);
    expect(api.acceptProposal).toHaveBeenCalledTimes(2);
    expect(journal()).toEqual({});
  });

  it('survives a crash between the write and the accept call: the reloaded journal finds the line', async () => {
    const p = proposal(7);
    const first = setup([p]);
    first.api.acceptProposal.mockImplementationOnce(() => new Promise(() => {})); // the process dies here
    void first.inbox.accept(p, draft(p));
    await vi.waitFor(() => expect(first.vault.files.size).toBe(1));

    const reloaded = setup([p], first.journal());
    reloaded.vault.files = first.vault.files;
    expect(reloaded.inbox.pendingWrite(7)?.notePath).toBe('Recall inbox/German/vocabulary.md');
    expect(await reloaded.inbox.accept(p, draft(p))).toEqual({ notePath: 'Recall inbox/German/vocabulary.md', appended: false });
    expect(reloaded.vault.writes).toEqual([]);
  });

  it('a journaled card whose line is missing (crash before the write) is written on retry', async () => {
    const p = proposal(8);
    const { vault, inbox } = setup([p], { 8: { notePath: 'Recall inbox/German/vocabulary.md', line: '- die Biene ::: the bee', deck: 'German/vocabulary' } });
    expect((await inbox.accept(p, draft(p))).appended).toBe(true);
    expect(vault.files.get('Recall inbox/German/vocabulary.md')).toContain('- die Biene ::: the bee');
  });

  it('409 (dismissed elsewhere) and 404 drop the journal entry and say where the card was written', async () => {
    const p = proposal(9), q = proposal(10, { sideA: 'der Käfer', sideB: 'the beetle' });
    const { api, inbox, journal } = setup([p, q]);
    api.acceptProposal.mockRejectedValueOnce(new RemoteError(409, 'Proposal was already dismissed'));
    const conflict = await inbox.accept(p, draft(p)).catch(e => e);
    expect(conflict).toBeInstanceOf(ProposalError);
    expect(conflict.gone).toBe(true);
    expect(conflict.message).toMatch(/already dismissed, but the card is in Recall inbox\/German\/vocabulary\.md/);
    api.acceptProposal.mockRejectedValueOnce(new RemoteError(404, 'Proposal not found'));
    await expect(inbox.accept(q, draft(q))).rejects.toThrow(/no longer exists/);
    expect(journal()).toEqual({});
  });

  it('writes nothing for a proposal that is no longer pending, or an invalid draft', async () => {
    const p = proposal(11, { status: 'dismissed' });
    const { vault, api, inbox } = setup([p]);
    await expect(inbox.accept(p, draft(p))).rejects.toMatchObject({ gone: true });
    await expect(inbox.accept(proposal(12), { ...draft(proposal(12)), sideA: 'a :: b' })).rejects.toThrow(/::/);
    expect(vault.writes).toEqual([]);
    expect(api.acceptProposal).not.toHaveBeenCalled();
  });

  it('refuses to append to a deck note whose tag was changed, and forgets the unwritten card', async () => {
    const p = proposal(13);
    const { vault, inbox, journal } = setup([p]);
    vault.files.set('Recall inbox/German/vocabulary.md', '---\ntags:\n  - Spanish\n---\n\n- x :: y\n');
    await expect(inbox.accept(p, draft(p))).rejects.toThrow(/does not have the tag German\/vocabulary/);
    expect(vault.writes).toEqual([]);
    expect(journal()).toEqual({});
  });

  it('a failed write leaves no journal entry', async () => {
    const p = proposal(14);
    const { vault, api, inbox, journal } = setup([p]);
    vault.failNextWrite = true;
    await expect(inbox.accept(p, draft(p))).rejects.toThrow(/Could not write to Recall inbox\/German\/vocabulary\.md: disk full/);
    expect(journal()).toEqual({});
    expect(api.acceptProposal).not.toHaveBeenCalled();
  });

  it('forget drops entries of proposals that are no longer pending', () => {
    const { inbox, journal } = setup([], { 1: { notePath: 'a.md', line: '- a :: b', deck: null }, 2: { notePath: 'b.md', line: '- c :: d', deck: null } });
    inbox.forget(new Set([2]));
    expect(Object.keys(journal())).toEqual(['2']);
    expect(inbox.pendingWrite(1)).toBeNull();
  });
});

describe('ProposalInbox.dismiss', () => {
  it('only calls the API', async () => {
    const p = proposal(20);
    const { vault, api, inbox } = setup([p]);
    expect(await inbox.dismiss(p)).toEqual({ leftIn: null });
    expect(api.dismissProposal).toHaveBeenCalledWith(20);
    expect(vault.writes).toEqual([]);
  });

  it('reports 409 (already accepted) and 404 as gone', async () => {
    const p = proposal(21);
    const { api, inbox } = setup([p]);
    api.dismissProposal.mockRejectedValueOnce(new RemoteError(409, 'Proposal was already accepted'));
    await expect(inbox.dismiss(p)).rejects.toMatchObject({ gone: true, message: 'This proposal was already accepted.' });
    api.dismissProposal.mockRejectedValueOnce(new RemoteError(404, 'Proposal not found'));
    await expect(inbox.dismiss(p)).rejects.toMatchObject({ gone: true, message: 'This proposal no longer exists.' });
  });

  it('dismissing a card written but not confirmed says where it stays', async () => {
    const p = proposal(22);
    const { inbox, journal } = setup([p], { 22: { notePath: 'Recall inbox/German/vocabulary.md', line: '- die Biene ::: the bee', deck: 'German/vocabulary' } });
    expect(await inbox.dismiss(p)).toEqual({ leftIn: 'Recall inbox/German/vocabulary.md' });
    expect(journal()).toEqual({});
  });
});
