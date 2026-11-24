import { describe, expect, it, vi } from 'vitest';
vi.mock('obsidian', () => ({ ItemView: class {}, Notice: class {}, MarkdownRenderer: {}, setIcon: vi.fn() }));
import { ProposalsView } from '../../../src/app/frontend/proposals-view';
import { DeckBrowserView } from '../../../src/app/frontend/deck-browser-view';
import { ProposalInbox, type InboxVault } from '../../../src/app/backend/proposal-inbox';
import { RemoteError } from '../../../src/app/backend/remote-client';
import type { CardProposal } from '../../../src/app/backend/study-client';

/** Just enough of Obsidian's element helpers to read back what the view rendered. */
class FakeEl {
  children: FakeEl[] = [];
  text: string; cls: string; value: string;
  disabled = false; selected = false; scrollTop = 0;
  listeners: Record<string, () => void> = {};
  constructor(readonly tag: string, options: { text?: string; cls?: string; value?: string } = {}) {
    this.text = options.text ?? ''; this.cls = options.cls ?? ''; this.value = options.value ?? '';
  }
  empty() { this.children = []; }
  addClass(cls: string) { this.cls = `${this.cls} ${cls}`.trim(); }
  setAttribute() {}
  querySelector(selector: string) { return this.all().find(e => e !== this && `.${e.cls}` === selector) ?? null; }
  remove() {}
  prepend(el: FakeEl) { this.children.unshift(el); }
  createEl(tag: string, options?: { text?: string; cls?: string; value?: string }) { const el = new FakeEl(tag, options); this.children.push(el); return el; }
  createDiv(options?: { text?: string; cls?: string }) { return this.createEl('div', options); }
  createSpan(options?: { text?: string; cls?: string }) { return this.createEl('span', options); }
  addEventListener(event: string, f: () => void) { this.listeners[event] = f; }
  all(): FakeEl[] { return [this, ...this.children.flatMap(c => c.all())]; }
  texts(): string { return this.all().map(e => e.text).filter(Boolean).join('\n'); }
  buttons(text: string) { return this.all().filter(e => e.tag === 'button' && e.text === text); }
  inputs() { return this.all().filter(e => e.tag === 'input'); }
}
const settle = () => new Promise(r => setTimeout(r, 0));

const proposal = (id: number, over: Partial<CardProposal> = {}): CardProposal => ({
  id, sideA: 'die Biene', sideB: 'the bee', directionality: 'bidirectional', deck: 'german/vocabulary', context: 'confused Biene and Bier',
  status: 'pending', origin: 'mcp', createdAt: '2026-11-12T08:00:00.000Z', decidedAt: null, notePath: null, ...over,
});

function setup(list: CardProposal[], options: { configured?: boolean; publishes?: boolean } = {}) {
  const files = new Map<string, string>();
  const vault: InboxVault = {
    read: async path => files.get(path) ?? null,
    create: async (path, content) => { files.set(path, content); },
    process: async (path, change) => { files.set(path, change(files.get(path)!)); },
  };
  const client: any = {
    isConfigured: () => options.configured ?? true,
    onChange: () => () => {},
    getProposals: vi.fn(async () => list.filter(p => p.status === 'pending').map(p => ({ ...p }))),
    getTags: vi.fn(async () => ({ tags: [{ tag: 'German', notes: 1, cards: 1, selected: true, followed: true }], untagged: { notes: 0, cards: 0, followed: false } })),
    getStudySettings: vi.fn(async () => ({ settings: { flashcardTags: ['German'] }, source: 'stored', revision: 1 })),
    acceptProposal: vi.fn(async (id: number, notePath: string) => { const p = list.find(x => x.id === id)!; p.status = 'accepted'; p.notePath = notePath; return p; }),
    dismissProposal: vi.fn(async (id: number) => { const p = list.find(x => x.id === id)!; p.status = 'dismissed'; return p; }),
  };
  const inbox = new ProposalInbox(client, vault, () => 'Recall inbox');
  const notify = vi.fn();
  const view: any = new ProposalsView({} as any, client, inbox, { publishesNotes: () => options.publishes ?? true, openNote: vi.fn(), notify });
  view.contentEl = new FakeEl('div');
  return { view, client, files, notify, el: () => view.contentEl as FakeEl };
}

describe('proposals panel: listing and refresh', () => {
  it('lists both sides, direction, resolved deck, context, date and target note', async () => {
    const { view, el } = setup([proposal(1), proposal(2, { sideA: 'Hauptstadt', sideB: 'capital', directionality: 'unidirectional', deck: null, context: null })]);
    await view.refresh();
    const text = el().texts();
    expect(text).toContain('die Biene');
    expect(text).toContain('the bee');
    expect(text).toContain('Both directions (:::)');
    expect(text).toContain(' · Deck: German/vocabulary'); // spelled like the existing tag
    expect(text).toContain('confused Biene and Bier');
    expect(text).toContain(` · Proposed ${new Date('2026-11-12T08:00:00.000Z').toLocaleString()}`);
    expect(text).toContain('Will be added to Recall inbox/German/vocabulary.md');
    expect(text).toContain('New deck: no note has the tag German/vocabulary yet.');
    expect(text).toContain('One direction (::)');
    expect(text).toContain('Will be added to Recall inbox/No deck.md');
    expect(text).toMatch(/Notes without tags are not studied while you follow tags/);
    expect(el().buttons('Accept')).toHaveLength(2);
    expect(el().buttons('Dismiss')).toHaveLength(2);
  });

  it('does not rebuild the DOM when nothing changed, and does when the list changes', async () => {
    const list = [proposal(1)];
    const { view } = setup(list);
    const render = vi.spyOn(view, 'renderContent');
    await view.refresh();
    await view.refresh();
    expect(render).toHaveBeenCalledTimes(1);
    list.push(proposal(2, { sideA: 'die Ameise', sideB: 'the ant' }));
    await view.refresh();
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('never rebuilds under an open edit form', async () => {
    const list = [proposal(1)];
    const { view, el } = setup(list);
    await view.refresh();
    el().buttons('Edit')[0].listeners.click();
    const render = vi.spyOn(view, 'renderContent');
    list.push(proposal(2, { sideA: 'die Ameise', sideB: 'the ant' }));
    await view.refresh();
    expect(render).not.toHaveBeenCalled();
  });

  it('shows the empty, loading, error and not-configured states', async () => {
    const { view, el } = setup([]);
    view.show(true);
    expect(el().texts()).toContain('Loading card proposals…');
    await view.refresh();
    expect(el().texts()).toMatch(/No pending card proposals/);

    const failing = setup([proposal(1)]);
    failing.client.getProposals.mockRejectedValueOnce(new Error('offline'));
    await failing.view.refresh();
    expect(failing.el().texts()).toContain('Cannot load card proposals: offline');
    expect(failing.el().buttons('Retry connection')).toHaveLength(1);
    await failing.view.refresh();
    expect(failing.el().texts()).toContain('die Biene');
    failing.client.getProposals.mockRejectedValueOnce(new Error('offline'));
    await failing.view.refresh();
    expect(failing.el().texts()).toMatch(/the list may be outdated\. offline/);
    expect(failing.el().texts()).toContain('die Biene');

    const unconfigured = setup([proposal(1)], { configured: false });
    await unconfigured.view.refresh();
    expect(unconfigured.el().texts()).toMatch(/backend URL and token in Settings/);
    expect(unconfigured.client.getProposals).not.toHaveBeenCalled();
  });

  it('warns when this device does not publish notes', async () => {
    const { view, el } = setup([proposal(1)], { publishes: false });
    await view.refresh();
    expect(el().texts()).toMatch(/This device does not publish notes/);
  });
});

describe('proposals panel: decisions', () => {
  it('Accept writes the card into the deck note, accepts it and removes it from the list', async () => {
    const { view, client, files, notify, el } = setup([proposal(1)]);
    await view.refresh();
    el().buttons('Accept')[0].listeners.click();
    await settle();
    expect(files.get('Recall inbox/German/vocabulary.md')).toBe('---\ntags:\n  - German/vocabulary\n---\n\n- die Biene ::: the bee\n');
    expect(client.acceptProposal).toHaveBeenCalledWith(1, 'Recall inbox/German/vocabulary.md');
    expect(notify).toHaveBeenCalledWith('Recall: card added to Recall inbox/German/vocabulary.md.');
    expect(el().texts()).toMatch(/No pending card proposals/);
  });

  it('Edit lets the owner change the sides, deck and direction before accepting', async () => {
    const { view, client, files, el } = setup([proposal(1)]);
    await view.refresh();
    el().buttons('Edit')[0].listeners.click();
    const [sideA, sideB, deck] = el().inputs();
    sideA.value = 'die Honigbiene'; sideA.listeners.input();
    sideB.value = 'the honeybee'; sideB.listeners.input();
    deck.value = '#german'; deck.listeners.input();
    const select = el().all().find(e => e.tag === 'select')!;
    select.value = 'unidirectional'; select.listeners.change();
    el().buttons('Accept')[0].listeners.click();
    await settle();
    expect(files.get('Recall inbox/German.md')).toBe('---\ntags:\n  - German\n---\n\n- die Honigbiene :: the honeybee\n');
    expect(client.acceptProposal).toHaveBeenCalledWith(1, 'Recall inbox/German.md');
    expect(view.editing).toBeNull();
  });

  it('an invalid edit is refused without writing', async () => {
    const { view, client, files, notify, el } = setup([proposal(1)]);
    await view.refresh();
    el().buttons('Edit')[0].listeners.click();
    const [sideA] = el().inputs();
    sideA.value = 'a :: b'; sideA.listeners.input();
    el().buttons('Accept')[0].listeners.click();
    await settle();
    expect(notify).toHaveBeenCalledWith('Recall: Side A must not contain "::".');
    expect(files.size).toBe(0);
    expect(client.getProposals).toHaveBeenCalledTimes(1);
  });

  it('a failed accept call leaves a Confirm button that retries without duplicating the line', async () => {
    const { view, client, files, notify, el } = setup([proposal(1)]);
    await view.refresh();
    client.acceptProposal.mockRejectedValueOnce(new Error('Backend connection timed out.'));
    el().buttons('Accept')[0].listeners.click();
    await settle();
    expect(notify.mock.calls.at(-1)[0]).toMatch(/backend did not confirm/);
    expect(el().texts()).toContain('Written to Recall inbox/German/vocabulary.md; waiting for the backend to confirm.');
    expect(el().buttons('Edit')).toHaveLength(0);
    el().buttons('Confirm')[0].listeners.click();
    await settle();
    expect(files.get('Recall inbox/German/vocabulary.md')!.match(/die Biene/g)).toHaveLength(1);
    expect(notify.mock.calls.at(-1)[0]).toBe('Recall: the card was already in Recall inbox/German/vocabulary.md; proposal accepted.');
    expect(el().texts()).toMatch(/No pending card proposals/);
  });

  it('Dismiss only calls the API', async () => {
    const { view, client, files, el } = setup([proposal(1)]);
    await view.refresh();
    el().buttons('Dismiss')[0].listeners.click();
    await settle();
    expect(client.dismissProposal).toHaveBeenCalledWith(1);
    expect(files.size).toBe(0);
    expect(el().texts()).toMatch(/No pending card proposals/);
  });

  it('a 409 on dismiss (accepted elsewhere) is reported and the list refreshed', async () => {
    const list = [proposal(1)];
    const { view, client, notify, el } = setup(list);
    await view.refresh();
    client.dismissProposal.mockImplementationOnce(async () => { list[0].status = 'accepted'; throw new RemoteError(409, 'Proposal was already accepted'); });
    el().buttons('Dismiss')[0].listeners.click();
    await settle();
    expect(notify).toHaveBeenCalledWith('Recall: This proposal was already accepted.');
    expect(el().texts()).toMatch(/No pending card proposals/);
  });

  it('disables every action while a decision is in flight', async () => {
    const { view, client, el } = setup([proposal(1), proposal(2, { sideA: 'die Ameise', sideB: 'the ant' })]);
    await view.refresh();
    let release!: () => void;
    client.dismissProposal.mockImplementationOnce(() => new Promise(done => { release = () => done(proposal(1, { status: 'dismissed' })); }));
    el().buttons('Dismiss')[0].listeners.click();
    await settle();
    expect(el().all().filter(e => e.tag === 'button' && ['Accept', 'Edit', 'Dismiss'].includes(e.text)).every(b => b.disabled)).toBe(true);
    expect(el().texts()).toContain('Working…');
    release();
    await settle();
  });
});

describe('deck browser link to the proposals', () => {
  const client = (count: number | Error) => ({
    isConfigured: () => true, expandedDeckIds: [],
    getDeckTree: { execute: vi.fn().mockResolvedValue([]) },
    getStudyStats: { execute: vi.fn().mockResolvedValue({ dueNow: 0, newItems: 0, totalItems: 0 }) },
    getLeeches: { execute: vi.fn().mockResolvedValue([]) },
    getProposals: vi.fn(async () => { if (count instanceof Error) throw count; return Array.from({ length: count }, (_, i) => proposal(i + 1)); }),
  });

  it('shows the pending count and opens the panel', async () => {
    const open = vi.fn();
    const view: any = new DeckBrowserView({} as any, client(3) as any, open);
    view.contentEl = new FakeEl('div');
    await view.refresh();
    const link = (view.contentEl as FakeEl).all().find(e => e.cls.includes('recall-proposals-link'))!;
    expect(link.text).toBe('3 card proposals →');
    expect(link.cls).toContain('recall-proposals-pending');
    link.listeners.click();
    expect(open).toHaveBeenCalled();
  });

  it('keeps a quiet link with none pending, and hides it when proposals cannot be loaded', async () => {
    const none: any = new DeckBrowserView({} as any, client(0) as any, vi.fn());
    none.contentEl = new FakeEl('div');
    await none.refresh();
    expect((none.contentEl as FakeEl).texts()).toContain('Card proposals');
    const failing: any = new DeckBrowserView({} as any, client(new Error('404')) as any, vi.fn());
    failing.contentEl = new FakeEl('div');
    await failing.refresh();
    expect((failing.contentEl as FakeEl).all().some(e => e.cls.includes('recall-proposals-link'))).toBe(false);
    expect((failing.contentEl as FakeEl).texts()).toContain('Recall');
  });
});
