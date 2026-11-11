import { describe, expect, it, vi } from 'vitest';
vi.mock('obsidian', () => ({ ItemView: class {}, Notice: class {}, MarkdownRenderer: {}, setIcon: vi.fn() }));
import { ReviewView } from '../../../src/app/frontend/review-view';
import { DeckBrowserView } from '../../../src/app/frontend/deck-browser-view';

const card = (id = 'a', revision = 1) => ({ studyItemId: id, conceptId: id, revision, sideA: 'Q', sideB: 'A' });
function review() {
  const client: any = { isConfigured: () => true,
    getDueStudyItems: { execute: vi.fn() }, hasPendingReview: () => false };
  const view: any = new ReviewView({} as any, client);
  view.render = vi.fn();
  return { view, client };
}

describe('remote review refresh', () => {
  it('preserves the visible card, its revealed answer, and event-handler identity on unchanged data', async () => {
    const { view, client } = review();
    client.getDueStudyItems.execute.mockResolvedValue([card()]);
    await view.loadItems(); view.answerRevealed = true;
    const original = view.items[0]; view.render.mockClear();
    client.getDueStudyItems.execute.mockResolvedValue([card()]);
    await view.loadItems();
    expect(view.items[0]).toBe(original); expect(view.answerRevealed).toBe(true);
    expect(view.render).not.toHaveBeenCalled();
  });
  it('removes cards reviewed elsewhere without counting them as local reviews', async () => {
    const { view, client } = review();
    client.getDueStudyItems.execute.mockResolvedValue([card(), card('b')]);
    await view.loadItems(); view.answerRevealed = true;
    client.getDueStudyItems.execute.mockResolvedValue([card('b')]); await view.loadItems();
    expect(view.items.map((x: any) => x.studyItemId)).toEqual(['b']);
    expect(view.answerRevealed).toBe(false); expect(view.reviewedCount).toBe(0);
  });
  it('hides an answer when its card revision changes', async () => {
    const { view, client } = review(); client.getDueStudyItems.execute.mockResolvedValue([card()]);
    await view.loadItems(); view.answerRevealed = true;
    client.getDueStudyItems.execute.mockResolvedValue([card('a', 2)]); await view.loadItems();
    expect(view.answerRevealed).toBe(false); expect(view.items[0].revision).toBe(2);
  });
  it('does not reconcile while an acknowledgement is unresolved', async () => {
    const { view, client } = review(); client.hasPendingReview = () => true;
    await view.loadItems(); expect(client.getDueStudyItems.execute).not.toHaveBeenCalled();
  });
  it('discards a fetch that began before a review submission', async () => {
    const { view, client } = review();
    let resolve!: (cards: any[]) => void;
    client.getDueStudyItems.execute.mockReturnValue(new Promise(done => { resolve = done; }));
    const pending = view.loadItems(); await Promise.resolve();
    view.live.invalidate(); resolve([card()]); await pending;
    expect(view.items).toEqual([]);
  });
  it('retains the queue through a connection failure and recovers', async () => {
    const { view, client } = review(); client.getDueStudyItems.execute.mockResolvedValue([card()]);
    await view.loadItems(); view.answerRevealed = true;
    client.getDueStudyItems.execute.mockRejectedValue(new Error('offline')); await view.loadItems();
    expect(view.items).toHaveLength(1); expect(view.loadError).toBe('offline');
    client.getDueStudyItems.execute.mockResolvedValue([card()]); await view.loadItems();
    expect(view.loadError).toBeNull(); expect(view.answerRevealed).toBe(true);
  });
});

describe('deck browser refresh', () => {
  it('detects changed deck structure even when all global totals stay identical', async () => {
    const client: any = { isConfigured: () => true, expandedDeckIds: [], getDeckTree: { execute: vi.fn().mockResolvedValue([{ name: 'Before' }]) },
      getStudyStats: { execute: vi.fn().mockResolvedValue({ dueNow: 1, totalItems: 1 }) },
      getLeeches: { execute: vi.fn().mockResolvedValue([]) } };
    const view: any = new DeckBrowserView({} as any, client);
    view.contentEl = { scrollTop: 123, querySelector: () => null };
    view.renderContent = vi.fn(); await view.refresh();
    client.getDeckTree.execute.mockResolvedValue([{ name: 'After' }]); await view.refresh();
    expect(view.renderContent).toHaveBeenCalledTimes(2);
    expect(view.contentEl.scrollTop).toBe(123);
    await view.refresh(); expect(view.renderContent).toHaveBeenCalledTimes(2);
  });
});

describe('backend not configured', () => {
  const element = () => {
    const created: string[] = [];
    const el: any = {
      scrollTop: 0, empty: vi.fn(), addClass: vi.fn(), focus: vi.fn(), querySelector: () => null,
      createDiv: () => el, setAttribute: vi.fn(),
      createEl: (_tag: string, options?: { text?: string }) => { if (options?.text) created.push(options.text); return el; },
    };
    return { el, created };
  };
  const unconfigured = () => ({ isConfigured: () => false, expandedDeckIds: [], hasPendingReview: () => false,
    getDueStudyItems: { execute: vi.fn() }, getDueStudyItemsByDeck: { execute: vi.fn() }, getDeckTree: { execute: vi.fn() },
    getStudyStats: { execute: vi.fn() }, getLeeches: { execute: vi.fn() } });

  it('deck browser explains how to configure the backend instead of requesting data', async () => {
    const client: any = unconfigured();
    const view: any = new DeckBrowserView({} as any, client);
    const { el, created } = element();
    view.contentEl = el;
    await view.render();
    expect(created.join(' ')).toMatch(/backend URL and token in Settings/);
    expect(client.getDeckTree.execute).not.toHaveBeenCalled();
    expect(client.getStudyStats.execute).not.toHaveBeenCalled();
  });

  it('review view explains how to configure the backend instead of requesting data', async () => {
    const client: any = unconfigured();
    const view: any = new ReviewView({} as any, client);
    const { el, created } = element();
    view.contentEl = el;
    await view.loadItems();
    await view.render();
    expect(created.join(' ')).toMatch(/backend URL and token in Settings/);
    expect(client.getDueStudyItems.execute).not.toHaveBeenCalled();
  });
});
