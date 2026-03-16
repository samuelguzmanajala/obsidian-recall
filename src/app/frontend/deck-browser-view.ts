import { ItemView, WorkspaceLeaf } from 'obsidian';
import { Container } from '@app/backend/container';
import { DeckTreeNode } from '@context/deck/application/get-deck-tree';
import { VIEW_TYPE_DECK_BROWSER, VIEW_TYPE_REVIEW } from './constants';

export class DeckBrowserView extends ItemView {
  private container: Container;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private lastHash = '';

  constructor(leaf: WorkspaceLeaf, container: Container) {
    super(leaf);
    this.container = container;
  }

  getViewType(): string {
    return VIEW_TYPE_DECK_BROWSER;
  }

  getDisplayText(): string {
    return 'Recall';
  }

  getIcon(): string {
    return 'brain';
  }

  async onOpen(): Promise<void> {
    await this.render();
    // Auto-refresh every 5s — lightweight: only re-renders if data changed
    this.refreshInterval = setInterval(() => this.refreshIfChanged(), 5000);
  }

  async onClose(): Promise<void> {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  private async refreshIfChanged(): Promise<void> {
    try {
      const stats = await this.container.getStudyStats.execute();
      const hash = `${stats.dueNow}:${stats.newItems}:${stats.totalItems}:${stats.reviewsToday}`;
      if (hash !== this.lastHash) {
        await this.render();
      }
    } catch {
      // Ignore errors during background refresh
    }
  }

  async render(): Promise<void> {
    const el = this.contentEl;
    el.empty();
    el.addClass('recall-deck-browser');

    const tree = await this.container.getDeckTree.execute();
    const stats = await this.container.getStudyStats.execute();

    // Update hash for change detection
    this.lastHash = `${stats.dueNow}:${stats.newItems}:${stats.totalItems}:${stats.reviewsToday}`;

    // Header
    const header = el.createDiv({ cls: 'recall-header' });
    header.createSpan({ text: 'Recall', cls: 'recall-title' });

    // Summary numbers
    const summary = el.createDiv({ cls: 'recall-summary' });
    this.createStat(summary, String(stats.dueNow), 'due', 'recall-count-due');
    this.createStat(summary, String(stats.newItems), 'new', 'recall-count-new');
    this.createStat(summary, String(stats.totalItems), 'total', 'recall-count-total');

    // Study all button
    if (stats.dueNow > 0) {
      const studyAllBtn = el.createEl('button', {
        text: `Study all →`,
        cls: 'recall-study-all',
      });
      studyAllBtn.addEventListener('click', () => this.openReview());
    }

    // Deck list
    const list = el.createDiv({ cls: 'recall-deck-list' });

    if (tree.length === 0) {
      list.createDiv({
        text: 'No decks yet. Add tags to your notes with flashcards.',
        cls: 'recall-empty',
      });
    }

    for (const node of tree) {
      this.renderDeckNode(list, node, 0);
    }
  }

  private createStat(parent: HTMLElement, value: string, label: string, cls: string): void {
    const stat = parent.createDiv({ cls: 'recall-stat' });
    stat.createSpan({ text: value, cls: `recall-stat-value ${cls}` });
    stat.createSpan({ text: label, cls: 'recall-stat-label' });
  }

  private renderDeckNode(parent: HTMLElement, node: DeckTreeNode, depth: number): void {
    const row = parent.createDiv({ cls: `recall-deck-row ${depth === 0 ? 'recall-deck-parent' : 'recall-deck-child'}` });
    if (depth > 0) {
      row.style.paddingLeft = `${depth * 20 + 8}px`;
    }

    row.createSpan({
      text: node.name,
      cls: 'recall-deck-name',
    });

    const counts = row.createDiv({ cls: 'recall-deck-counts' });
    if (node.dueItems > 0) {
      counts.createSpan({ text: String(node.dueItems), cls: 'recall-count-due' });
    }
    if (node.newItems > 0) {
      counts.createSpan({ text: String(node.newItems), cls: 'recall-count-new' });
    }
    counts.createSpan({ text: String(node.totalItems), cls: 'recall-count-total' });

    if (depth === 0 && node.dueItems > 0) {
      const btn = row.createSpan({ text: 'Study →', cls: 'recall-study-link' });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openReview(node.id);
      });
    }

    // Render children
    for (const child of node.children) {
      this.renderDeckNode(parent, child, depth + 1);
    }
  }

  private async openReview(deckId?: string): Promise<void> {
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({
      type: VIEW_TYPE_REVIEW,
      state: { deckId: deckId ?? null },
    });
    this.app.workspace.revealLeaf(leaf);
  }
}
