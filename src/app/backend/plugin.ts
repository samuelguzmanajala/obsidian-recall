import { Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { Container } from './container';
import { createObsidianFilePort } from './obsidian-storage';
import { VaultSync } from './vault-sync';
import { DeckBrowserView } from '@app/frontend/deck-browser-view';
import { ReviewView } from '@app/frontend/review-view';
import { VIEW_TYPE_DECK_BROWSER, VIEW_TYPE_REVIEW } from '@app/frontend/constants';
import { RecallSettings, DEFAULT_SETTINGS, RecallSettingTab } from './settings';

export default class RecallPlugin extends Plugin {
  container!: Container;
  vaultSync!: VaultSync;
  settings!: RecallSettings;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly DEBOUNCE_MS = 500;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.container = new Container({
      concepts: createObsidianFilePort(this.app, 'concepts.json'),
      studyItems: createObsidianFilePort(this.app, 'study-items.json'),
      decks: createObsidianFilePort(this.app, 'decks.json'),
      reviews: createObsidianFilePort(this.app, 'reviews.json'),
      syncState: createObsidianFilePort(this.app, 'sync-state.json'),
    });
    this.container.settings = this.settings;
    this.vaultSync = new VaultSync(this.container);
    this.container.vaultSync = this.vaultSync;

    // Register views
    this.registerView(VIEW_TYPE_DECK_BROWSER, (leaf: WorkspaceLeaf) =>
      new DeckBrowserView(leaf, this.container),
    );
    this.registerView(VIEW_TYPE_REVIEW, (leaf: WorkspaceLeaf) =>
      new ReviewView(leaf, this.container),
    );

    // Ribbon icon to open deck browser
    this.addRibbonIcon('brain', 'Recall — Deck browser', () => {
      this.activateDeckBrowser();
    });

    // Command to open deck browser
    this.addCommand({
      id: 'open-deck-browser',
      name: 'Open deck browser',
      callback: () => this.activateDeckBrowser(),
    });

    // Command to start review (all decks)
    this.addCommand({
      id: 'start-review',
      name: 'Start review',
      callback: () => this.openReview(),
    });

    // Settings tab
    this.addSettingTab(new RecallSettingTab(this.app, this));

    // Pass settings to VaultSync for tag filtering
    this.vaultSync.setAllowedTags(this.settings.flashcardTags);

    // Load existing sync state
    await this.vaultSync.initialize();

    // Wait for vault to be ready before syncing files
    this.app.workspace.onLayoutReady(async () => {
      await this.initialSync();
    });

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          this.debouncedSync(file);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          this.cancelPendingSync(file.path);
          this.vaultSync.removeFile(file.path);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile && file.extension === 'md') {
          this.cancelPendingSync(oldPath);
          this.vaultSync.renameFile(oldPath, file.path).then(
            () => this.debouncedSync(file),
            (err) => console.warn(`Recall: failed to rename ${oldPath}`, err),
          );
        }
      }),
    );

    console.log('Recall plugin loaded');
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.previousTags = [...this.settings.flashcardTags];
  }

  private previousTags: string[] = [];

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.container.settings = this.settings;

    // Only reset + rebuild if tags actually changed
    const tagsChanged = JSON.stringify(this.settings.flashcardTags) !== JSON.stringify(this.previousTags);
    if (tagsChanged) {
      this.previousTags = [...this.settings.flashcardTags];
      this.vaultSync.setAllowedTags(this.settings.flashcardTags);
      await this.vaultSync.resetAll();
      await this.initialSync();
    }

    // Refresh deck browser if open
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_DECK_BROWSER);
    for (const leaf of leaves) {
      const view = leaf.view as DeckBrowserView;
      if (view.render) await view.render();
    }
  }

  private async activateDeckBrowser(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_DECK_BROWSER);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeftLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE_DECK_BROWSER, active: true });
      this.app.workspace.revealLeaf(leaf);
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

  onunload(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    console.log('Recall plugin unloaded');
  }

  private async initialSync(): Promise<void> {
    await this.vaultSync.beginBatch();
    const files = this.app.vault.getMarkdownFiles();
    let synced = 0;
    let skipped = 0;
    for (const file of files) {
      try {
        const content = await this.app.vault.cachedRead(file);
        const had = await this.vaultSync.syncFile(file.path, content);
        if (had) synced++; else skipped++;
      } catch (err) {
        console.warn(`Recall: failed to sync ${file.path}`, err);
      }
    }
    await this.vaultSync.endBatch();
    console.log(`Recall: initial sync done — ${synced} files indexed, ${skipped} skipped, ${files.length} total`);
  }

  private cancelPendingSync(path: string): void {
    const timer = this.debounceTimers.get(path);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(path);
    }
  }

  private debouncedSync(file: TFile): void {
    this.cancelPendingSync(file.path);

    this.debounceTimers.set(
      file.path,
      setTimeout(async () => {
        this.debounceTimers.delete(file.path);
        try {
          const content = await this.app.vault.read(file);
          await this.vaultSync.syncFile(file.path, content);
        } catch (err) {
          console.warn(`Recall: failed to sync ${file.path}`, err);
        }
      }, RecallPlugin.DEBOUNCE_MS),
    );
  }
}
