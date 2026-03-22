import { ItemView, MarkdownRenderer, WorkspaceLeaf } from 'obsidian';
import { Container } from '@app/backend/container';
import { ConceptId } from '@context/concept/domain/concept-id';
import { StudyItemId } from '@context/study/domain/study-item-id';
import { DueStudyItemView } from '@context/study/application/study-item-view';
import { Rating } from '@context/study/domain/rating';
import { Direction } from '@context/study/domain/direction';
import { MemoryState } from '@context/study/domain/memory-state';
import { VIEW_TYPE_REVIEW, RATING_LABELS, RATING_COLORS } from './constants';
import { formatInterval } from './format-interval';

interface ReviewState extends Record<string, unknown> {
  deckId: string | null;
}

export class ReviewView extends ItemView {
  private container: Container;
  private items: DueStudyItemView[] = [];
  private currentIndex = 0;
  private totalCount = 0;
  private answerRevealed = false;
  private deckId: string | null = null;
  private deckName = '';

  constructor(leaf: WorkspaceLeaf, container: Container) {
    super(leaf);
    this.container = container;
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
    this.deckId = state.deckId ?? null;
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

    // Re-render current card when switching back to this tab (after editing note)
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        if (leaf === this.leaf) {
          setTimeout(() => this.refreshCurrentCard(), 600);
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

  /**
   * Refresh the current card's content from the repository
   * (in case the user edited the source note).
   */
  private async refreshCurrentCard(): Promise<void> {
    if (this.items.length === 0 || this.currentIndex >= this.items.length) return;

    const item = this.items[this.currentIndex];

    // Check if the study item still exists (might have been replaced after edit)
    const studyItem = await this.container.studyItemRepository.findById(
      new StudyItemId(item.studyItemId),
    );

    if (!studyItem) {
      // Card was edited — VaultSync replaced it with a new StudyItem.
      // Try to find the replacement by looking at the source file.
      const replacement = await this.findReplacementItem(item);
      if (replacement) {
        // Swap in the new data, keep position in queue
        Object.assign(item, replacement);
        this.answerRevealed = false;
        this.render();
      } else {
        // No replacement found — remove from queue
        this.items.splice(this.currentIndex, 1);
        if (this.currentIndex >= this.items.length) this.currentIndex = 0;
        this.answerRevealed = false;
        this.render();
      }
      return;
    }

    // StudyItem exists — check if concept content was updated in place
    const concept = await this.container.conceptRepository.findById(
      new ConceptId(item.conceptId),
    );
    if (!concept) {
      this.items.splice(this.currentIndex, 1);
      if (this.currentIndex >= this.items.length) this.currentIndex = 0;
      this.answerRevealed = false;
      this.render();
      return;
    }

    if (concept.sideA.content !== item.sideA || concept.sideB.content !== item.sideB) {
      item.sideA = concept.sideA.content;
      item.sideB = concept.sideB.content;
      this.answerRevealed = false;
      this.render();
    }
  }

  private getLimits(): { maxNew: number; maxReview: number } | undefined {
    const s = this.container.settings;
    if (!s) return undefined;
    if (s.dailyNewLimit === 0 && s.dailyReviewLimit === 0) return undefined;
    return { maxNew: s.dailyNewLimit, maxReview: s.dailyReviewLimit };
  }

  private async loadItems(): Promise<void> {
    const limits = this.getLimits();
    if (this.deckId) {
      this.items = await this.container.getDueStudyItemsByDeck.execute(this.deckId, new Date(), limits);
      const tree = await this.container.getDeckTree.execute();
      this.deckName = this.findDeckName(tree, this.deckId) ?? 'Deck';
    } else {
      this.items = await this.container.getDueStudyItems.execute(new Date(), limits);
      this.deckName = 'All decks';
    }
    // Shuffle if enabled in settings
    if (this.container.settings?.shuffleReviews !== false) {
      this.shuffleArray(this.items);
    }
    this.totalCount = this.items.length;
    this.currentIndex = 0;
    this.answerRevealed = false;
  }

  private shuffleArray<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
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
    const el = this.contentEl;
    el.empty();
    el.addClass('recall-review');
    el.focus();

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
      ? ((this.totalCount - this.items.length + this.currentIndex) / this.totalCount) * 100
      : 0;
    bar.style.width = `${progress}%`;

    header.createSpan({
      text: `${this.totalCount - this.items.length + this.currentIndex + 1}/${this.totalCount}`,
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

    if (this.answerRevealed) {
      // Divider
      cardArea.createDiv({ cls: 'recall-card-divider' });

      // Answer
      const answerSection = cardArea.createDiv({ cls: 'recall-card-section' });
      answerSection.createDiv({ text: 'A', cls: 'recall-card-label recall-label-answer' });
      const answerText = answerSection.createDiv({ cls: 'recall-card-text recall-text-answer' });
      await MarkdownRenderer.render(this.app, answer, answerText, '', this);

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

    const currentState = new MemoryState(
      item.stability,
      item.difficulty,
      item.due,
      item.reps,
      item.lapses,
      item.lastReview,
    );
    const previews = this.container.scheduler.previewAll(currentState, new Date());

    for (let i = 0; i < ratings.length; i++) {
      const rating = ratings[i];
      const preview = previews[i];

      const shortcutKey = String(i + 1);

      const btn = buttons.createDiv({
        cls: `recall-rating-btn ${RATING_COLORS[rating]}`,
      });

      btn.createSpan({ text: RATING_LABELS[rating], cls: 'recall-rating-label' });
      btn.createSpan({ text: formatInterval(preview.intervalDays), cls: 'recall-rating-interval' });
      btn.createSpan({ text: shortcutKey, cls: 'recall-rating-shortcut' });

      btn.addEventListener('click', () => this.submitRating(item, rating));
    }
  }

  private async submitRating(item: DueStudyItemView, rating: Rating): Promise<void> {
    try {
      await this.container.reviewStudyItem.execute({
        studyItemId: item.studyItemId,
        rating,
      });
    } catch {
      // StudyItem may have been replaced (card edited) — skip
    }

    // Remove this card and any sibling (other direction of same concept)
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
  }

  private renderComplete(el: HTMLElement): void {
    const done = el.createDiv({ cls: 'recall-complete' });
    done.createDiv({ text: '✓', cls: 'recall-complete-icon' });
    done.createDiv({ text: 'All done!', cls: 'recall-complete-title' });
    done.createDiv({
      text: `${this.totalCount} cards reviewed`,
      cls: 'recall-complete-subtitle',
    });

    const backBtn = done.createEl('button', {
      text: '← Back to decks',
      cls: 'recall-back-link',
    });
    backBtn.addEventListener('click', () => this.goBack());
  }

  /**
   * When a card is edited, VaultSync creates a new Concept + StudyItem.
   * Try to find the new item that replaced the old one by matching
   * direction and source file.
   */
  private async findReplacementItem(oldItem: DueStudyItemView): Promise<DueStudyItemView | null> {
    // Find the source file of the old concept
    const oldFile = this.container.vaultSync?.findFileByConceptId(oldItem.conceptId);

    // Get all due items and find one from the same file with the same direction
    // that isn't already in our queue
    const existingIds = new Set(this.items.map(i => i.studyItemId));
    const allDue = await this.container.getDueStudyItems.execute();

    for (const candidate of allDue) {
      if (existingIds.has(candidate.studyItemId)) continue;
      if (candidate.direction !== oldItem.direction) continue;

      const candidateFile = this.container.vaultSync?.findFileByConceptId(candidate.conceptId);
      if (candidateFile && oldFile && candidateFile.filePath === oldFile.filePath) {
        return candidate;
      }
    }

    return null;
  }

  private async openSourceNote(conceptId: string): Promise<void> {
    const result = this.container.vaultSync?.findFileByConceptId(conceptId);
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
