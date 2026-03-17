import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian';
import { Container } from '@app/backend/container';
import { DeckTreeNode } from '@context/deck/application/get-deck-tree';
import { LeechView } from '@context/study/application/get-leeches';
import { Direction } from '@context/study/domain/direction';
import { VIEW_TYPE_DECK_BROWSER, VIEW_TYPE_REVIEW } from './constants';

export class DeckBrowserView extends ItemView {
  private container: Container;
  private lastHash = '';
  private leechesExpanded = false;

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
  }

  /** Called externally when data changes (Sync, review, settings) */
  async refresh(): Promise<void> {
    try {
      const stats = await this.container.getStudyStats.execute();
      const hash = `${stats.dueNow}:${stats.newItems}:${stats.totalItems}:${stats.reviewsToday}`;
      if (hash !== this.lastHash) {
        await this.render();
      }
    } catch {
      // Ignore errors during refresh
    }
  }

  async render(): Promise<void> {
    const el = this.contentEl;
    el.empty();
    el.addClass('recall-deck-browser');

    const tree = await this.container.getDeckTree.execute();
    const stats = await this.container.getStudyStats.execute();

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
        text: 'Study all →',
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

    // Leeches section
    const threshold = this.container.settings?.leechThreshold ?? 8;
    if (threshold > 0) {
      const leeches = await this.container.getLeeches.execute(threshold);
      if (leeches.length > 0) {
        this.renderLeechSection(el, leeches);
      }
    }
  }

  private createStat(parent: HTMLElement, value: string, label: string, cls: string): void {
    const stat = parent.createDiv({ cls: 'recall-stat' });
    stat.createSpan({ text: value, cls: `recall-stat-value ${cls}` });
    stat.createSpan({ text: label, cls: 'recall-stat-label' });
  }

  private renderDeckNode(parent: HTMLElement, node: DeckTreeNode, depth: number): void {
    const hasChildren = node.children.length > 0;
    const expandedIds = this.container.settings?.expandedDeckIds ?? [];
    const isCollapsed = !expandedIds.includes(node.id);

    const wrapper = parent.createDiv({ cls: 'recall-deck-wrapper' });

    const row = wrapper.createDiv({
      cls: `recall-deck-row ${depth === 0 ? 'recall-deck-parent' : 'recall-deck-child'}`,
    });
    if (depth > 0) {
      row.style.paddingLeft = `${depth * 20 + 8}px`;
    }

    // Left side: collapse toggle + name
    const left = row.createDiv({ cls: 'recall-deck-left' });

    if (hasChildren) {
      const toggle = left.createSpan({ cls: 'recall-collapse-toggle' });
      setIcon(toggle, isCollapsed ? 'chevron-right' : 'chevron-down');
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleDeckExpanded(node.id);
        this.render();
      });
    } else {
      // Spacer to align names
      left.createSpan({ cls: 'recall-collapse-spacer' });
    }

    left.createSpan({ text: node.name, cls: 'recall-deck-name' });

    // Right side: counts + study button
    const right = row.createDiv({ cls: 'recall-deck-right' });

    const counts = right.createDiv({ cls: 'recall-deck-counts' });
    if (node.dueItems > 0) {
      counts.createSpan({ text: String(node.dueItems), cls: 'recall-count-due' });
    }
    if (node.newItems > 0) {
      counts.createSpan({ text: String(node.newItems), cls: 'recall-count-new' });
    }
    counts.createSpan({ text: String(node.totalItems), cls: 'recall-count-total' });

    // Study button on every level with due items
    if (node.dueItems > 0) {
      const btn = right.createSpan({ text: 'Study →', cls: 'recall-study-link' });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openReview(node.id);
      });
    }

    // Render children if not collapsed
    if (hasChildren && !isCollapsed) {
      for (const child of node.children) {
        this.renderDeckNode(wrapper, child, depth + 1);
      }
    }
  }

  private renderLeechSection(parent: HTMLElement, leeches: LeechView[]): void {
    const section = parent.createDiv({ cls: 'recall-leech-section' });

    const header = section.createDiv({ cls: 'recall-leech-header' });
    const toggle = header.createSpan({ cls: 'recall-collapse-toggle' });
    setIcon(toggle, this.leechesExpanded ? 'chevron-down' : 'chevron-right');

    header.createSpan({ text: `🩸 Leeches (${leeches.length})`, cls: 'recall-leech-title' });

    header.addEventListener('click', () => {
      this.leechesExpanded = !this.leechesExpanded;
      this.render();
    });

    if (this.leechesExpanded) {
      const list = section.createDiv({ cls: 'recall-leech-list' });
      for (const leech of leeches) {
        const row = list.createDiv({ cls: 'recall-leech-row' });

        const question = leech.direction === Direction.AtoB ? leech.sideA : leech.sideB;
        // Truncate long questions
        const display = question.length > 60 ? question.slice(0, 57) + '...' : question;

        const left = row.createDiv({ cls: 'recall-leech-left' });
        left.createSpan({ text: display, cls: 'recall-leech-text' });
        left.createSpan({
          text: `${leech.lapses} lapses`,
          cls: 'recall-leech-count',
        });

        const openBtn = row.createSpan({ text: '📝', cls: 'recall-leech-edit' });
        openBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.openLeechNote(leech.conceptId);
        });
      }
    }
  }

  private async openLeechNote(conceptId: string): Promise<void> {
    const result = this.container.vaultSync?.findFileByConceptId(conceptId);
    if (!result) return;

    const file = this.app.vault.getAbstractFileByPath(result.filePath);
    if (!file) return;

    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.openFile(file as any, {
      eState: { line: result.line - 1 },
    });
  }

  private toggleDeckExpanded(deckId: string): void {
    const settings = this.container.settings;
    if (!settings) return;

    const ids = settings.expandedDeckIds;
    const idx = ids.indexOf(deckId);
    if (idx >= 0) {
      ids.splice(idx, 1);
    } else {
      ids.push(deckId);
    }

    // Persist quietly (no reset, no re-sync)
    this.container.saveSettingsQuiet?.();
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
