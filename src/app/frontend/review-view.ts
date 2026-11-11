import { ItemView, MarkdownRenderer, WorkspaceLeaf, Notice } from 'obsidian';
import type { StudyClient } from '@app/backend/study-client';
import { RemoteError } from '@app/backend/remote-client';
import type { DueStudyItemView } from '@context/study/application/study-item-view';
import { Rating } from '@context/study/domain/rating';
import { Direction } from '@context/study/domain/direction';
import { VIEW_TYPE_REVIEW, RATING_LABELS, RATING_COLORS } from './constants';
import { formatInterval } from './format-interval';
import { LiveRefresh } from './live-refresh';
import { renderNotConfigured } from './not-configured';

interface ReviewState extends Record<string, unknown> {
  deckId: string | null;
}

export class ReviewView extends ItemView {
  private client: StudyClient;
  private submitting = false;
  private loadError: string | null = null;
  private items: DueStudyItemView[] = [];
  private currentIndex = 0;
  private totalCount = 0;
  private answerRevealed = false;
  private deckId: string | null = null;
  private deckName = '';
  private reviewedCount = 0;
  private renderGeneration = 0;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private live = new LiveRefresh(current => this.refresh(current));

  constructor(leaf: WorkspaceLeaf, client: StudyClient) {
    super(leaf);
    this.client = client;
  }

  getViewType(): string {
    return VIEW_TYPE_REVIEW;
  }

  getDisplayText(): string {
    return 'Review';
  }

  getIcon(): string {
    return 'sparkles';
  }

  async setState(state: ReviewState): Promise<void> {
    if (this.submitting || this.client.hasPendingReview()) {
      new Notice('Confirm the pending review before changing decks.');
      return;
    }
    this.live.invalidate();
    this.deckId = state.deckId ?? null;
    this.items = [];
    this.reviewedCount = 0;
    await this.loadItems();
    this.render();
  }

  getState(): ReviewState {
    return { deckId: this.deckId };
  }

  async onOpen(): Promise<void> {
    // Make focusable for keyboard shortcuts
    this.contentEl.tabIndex = 0;
    this.contentEl.focus();

    await this.loadItems();
    this.render();

    if (this.live.stopped || !this.client.isConfigured()) return;
    const refreshVisible = () => {
      if (!this.contentEl.ownerDocument.hidden && this.contentEl.getClientRects().length) void this.live.request();
    };
    this.refreshTimer = setInterval(refreshVisible, 10_000);
    this.registerDomEvent(this.contentEl.ownerDocument, 'visibilitychange', refreshVisible);
    this.registerDomEvent(this.contentEl.ownerDocument.defaultView!, 'focus', refreshVisible);
    this.register(this.client.onChange(refreshVisible));

    // Re-render current card when switching back to this tab (after editing note)
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        if (leaf === this.leaf) {
          void this.live.request();
        }
      }),
    );

    // Keyboard shortcuts
    this.registerDomEvent(this.contentEl, 'keydown', (e: KeyboardEvent) => {
      if (this.items.length === 0) return;
      const item = this.items[this.currentIndex];
      if (!item) return;

      if (!this.answerRevealed) {
        // Space or Enter → reveal answer
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          this.answerRevealed = true;
          this.render();
        }
      } else {
        // 1 = Again, 2 = Hard, 3 = Good, 4 = Easy
        const ratingMap: Record<string, Rating> = {
          '1': Rating.Again,
          '2': Rating.Hard,
          '3': Rating.Good,
          '4': Rating.Easy,
        };
        if (e.key in ratingMap) {
          e.preventDefault();
          this.submitRating(item, ratingMap[e.key]);
        }
        // Space → Good (most common)
        if (e.key === ' ') {
          e.preventDefault();
          this.submitRating(item, Rating.Good);
        }
      }
    });
  }

  /** The backend owns the queue: limits, order and previews arrive with each refresh. */
  private async loadItems(): Promise<void> {
    await this.live.request();
  }

  async onClose(): Promise<void> {
    this.live.close();
    this.renderGeneration++;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  private async refresh(isCurrent: () => boolean): Promise<void> {
    // A lost acknowledgement must be resolved with the same operation ID before
    // replacing the displayed card or its revision.
    if (this.submitting || !this.client.isConfigured()) return;
    const deckId = this.deckId;
    try {
      if (this.client.hasPendingReview()) {
        await this.client.retryPendingReviews();
        if (!isCurrent() || this.submitting) return;
      }
      const [fresh, tree] = await Promise.all([
        deckId ? this.client.getDueStudyItemsByDeck.execute(deckId) : this.client.getDueStudyItems.execute(),
        deckId ? this.client.getDeckTree.execute() : Promise.resolve([]),
      ]);
      if (!isCurrent() || this.submitting || this.client.hasPendingReview()) return;
      const previous = this.items[this.currentIndex];
      const freshById = new Map(fresh.map(item => [item.studyItemId, item]));
      const ordered = this.items.map(item => freshById.get(item.studyItemId)).filter((item): item is DueStudyItemView => !!item);
      const known = new Set(ordered.map(item => item.studyItemId));
      const added = fresh.filter(item => !known.has(item.studyItemId));
      const next = [...ordered, ...added];
      const nextIndex = previous ? next.findIndex(item => item.studyItemId === previous.studyItemId) : 0;
      const current = next[Math.max(0, nextIndex)];
      const sameCard = !!previous && !!current && previous.studyItemId === current.studyItemId
        && previous.revision === current.revision && previous.sideA === current.sideA && previous.sideB === current.sideB;
      const deckName = deckId ? this.findDeckName(tree, deckId) ?? 'Deck' : 'All decks';
      const changed = this.loadError !== null || deckName !== this.deckName || JSON.stringify(next) !== JSON.stringify(this.items);
      // Keep object identities captured by visible rating buttons if unchanged.
      if (!changed) return;
      this.items = next;
      this.currentIndex = Math.max(0, nextIndex);
      this.totalCount = this.reviewedCount + next.length;
      this.deckName = deckName;
      this.loadError = null;
      if (!sameCard) this.answerRevealed = false;
      if (changed) await this.render();
    } catch (error) {
      if (!isCurrent() || this.submitting) return;
      this.loadError = (error as Error).message;
      await this.render();
    }
  }

  private findDeckName(nodes: { id: string; name: string; children: any[] }[], id: string): string | null {
    for (const node of nodes) {
      if (node.id === id) return node.name;
      const found = this.findDeckName(node.children, id);
      if (found) return found;
    }
    return null;
  }

  private async render(): Promise<void> {
    const generation = ++this.renderGeneration;
    const el = this.contentEl;
    el.empty();
    el.addClass('recall-review');
    el.focus();

    if (!this.client.isConfigured()) {
      renderNotConfigured(el);
      return;
    }

    if (this.loadError) {
      el.createEl('p', { text: `Cannot load reviews: ${this.loadError}` });
      el.createEl('button', { text: 'Retry connection' }).addEventListener('click', async () => {
        await this.loadItems(); await this.render();
      });
      return;
    }

    if (this.items.length === 0) {
      this.renderComplete(el);
      return;
    }

    const item = this.items[this.currentIndex];
    if (!item) {
      this.renderComplete(el);
      return;
    }

    // Header
    const header = el.createDiv({ cls: 'recall-review-header' });

    const backBtn = header.createSpan({ text: '←', cls: 'recall-back-btn' });
    backBtn.addEventListener('click', () => this.goBack());

    header.createSpan({ text: this.deckName, cls: 'recall-review-deck' });

    const progressWrap = header.createDiv({ cls: 'recall-progress-wrap' });
    const bar = progressWrap.createDiv({ cls: 'recall-progress-bar' });
    const progress = this.totalCount > 0
      ? (this.reviewedCount / this.totalCount) * 100
      : 0;
    bar.style.width = `${progress}%`;

    header.createSpan({
      text: `${this.reviewedCount} reviewed · ${this.items.length} remaining`,
      cls: 'recall-progress-text',
    });

    // Card toolbar
    const toolbar = el.createDiv({ cls: 'recall-card-toolbar' });
    const openNoteBtn = toolbar.createSpan({ text: '📝 Open note', cls: 'recall-open-note' });
    openNoteBtn.addEventListener('click', () => this.openSourceNote(item.conceptId));

    // Card area
    const cardArea = el.createDiv({ cls: 'recall-card-area' });

    // Determine what to show based on direction
    const question = item.direction === Direction.AtoB ? item.sideA : item.sideB;
    const answer = item.direction === Direction.AtoB ? item.sideB : item.sideA;

    // Question
    const questionSection = cardArea.createDiv({ cls: 'recall-card-section' });
    questionSection.createDiv({ text: 'Q', cls: 'recall-card-label' });
    const questionText = questionSection.createDiv({ cls: 'recall-card-text' });
    await MarkdownRenderer.render(this.app, question, questionText, '', this);
    if (generation !== this.renderGeneration) return;

    if (this.answerRevealed) {
      // Divider
      cardArea.createDiv({ cls: 'recall-card-divider' });

      // Answer
      const answerSection = cardArea.createDiv({ cls: 'recall-card-section' });
      answerSection.createDiv({ text: 'A', cls: 'recall-card-label recall-label-answer' });
      const answerText = answerSection.createDiv({ cls: 'recall-card-text recall-text-answer' });
      await MarkdownRenderer.render(this.app, answer, answerText, '', this);
      if (generation !== this.renderGeneration) return;

      // Rating buttons
      this.renderRatingButtons(el, item);
    } else {
      // Reveal button
      const revealBtn = el.createEl('button', {
        cls: 'recall-reveal-btn',
      });
      revealBtn.createSpan({ text: 'Show answer' });
      revealBtn.createSpan({ text: 'space', cls: 'recall-reveal-shortcut' });
      revealBtn.addEventListener('click', () => {
        this.answerRevealed = true;
        this.render();
      });
    }
  }

  private renderRatingButtons(parent: HTMLElement, item: DueStudyItemView): void {
    const buttons = parent.createDiv({ cls: 'recall-rating-buttons' });

    const ratings = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];

    const previews = item.preview
      ? [item.preview.againDays, item.preview.hardDays, item.preview.goodDays, item.preview.easyDays].map(intervalDays => ({ intervalDays }))
      : undefined;

    for (let i = 0; i < ratings.length; i++) {
      const rating = ratings[i];
      const preview = previews?.[i];

      const shortcutKey = String(i + 1);

      const btn = buttons.createDiv({
        cls: `recall-rating-btn ${RATING_COLORS[rating]}`,
      });

      btn.createSpan({ text: RATING_LABELS[rating], cls: 'recall-rating-label' });
      btn.createSpan({ text: preview ? formatInterval(preview.intervalDays) : '', cls: 'recall-rating-interval' });
      btn.createSpan({ text: shortcutKey, cls: 'recall-rating-shortcut' });

      btn.addEventListener('click', () => this.submitRating(item, rating));
    }
  }

  private async submitRating(item: DueStudyItemView, rating: Rating): Promise<void> {
    if (this.submitting || item !== this.items[this.currentIndex]) return;
    this.live.invalidate();
    this.submitting = true;
    this.contentEl.setAttribute('aria-busy', 'true');
    try {
      await this.client.reviewStudyItem.execute({
        studyItemId: item.studyItemId,
        expectedRevision: item.revision,
        rating,
      });
    } catch (error) {
      new Notice(`Recall: ${error instanceof Error ? error.message : 'Review not saved'}`);
      if (error instanceof RemoteError && (error.status === 409 || error.status === 404)) {
        this.submitting = false;
        await this.loadItems();
        await this.render();
      }
      return;
    } finally {
      this.submitting = false;
      this.contentEl.removeAttribute('aria-busy');
    }

    // Remove this card and any sibling (other direction of same concept)
    this.reviewedCount++;
    const reviewedConceptId = item.conceptId;
    this.items = this.items.filter((v, idx) => {
      if (idx === this.currentIndex) return false; // remove current
      if (v.conceptId === reviewedConceptId && v.studyItemId !== item.studyItemId) return false; // remove sibling
      return true;
    });
    if (this.currentIndex >= this.items.length) {
      this.currentIndex = 0;
    }
    this.answerRevealed = false;
    this.render();
    await this.live.request();
  }

  private renderComplete(el: HTMLElement): void {
    const done = el.createDiv({ cls: 'recall-complete' });
    done.createDiv({ text: '✓', cls: 'recall-complete-icon' });
    done.createDiv({ text: 'All done!', cls: 'recall-complete-title' });
    done.createDiv({
      text: `${this.reviewedCount} cards reviewed in this session`,
      cls: 'recall-complete-subtitle',
    });

    const backBtn = done.createEl('button', {
      text: '← Back to decks',
      cls: 'recall-back-link',
    });
    backBtn.addEventListener('click', () => this.goBack());
  }

  private async openSourceNote(conceptId: string): Promise<void> {
    const result = this.client.findSource(conceptId);
    if (!result) return;

    const file = this.app.vault.getAbstractFileByPath(result.filePath);
    if (!file) return;

    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.openFile(file as any, {
      eState: { line: result.line - 1 },
    });
  }

  private goBack(): void {
    this.leaf.detach();
  }
}
