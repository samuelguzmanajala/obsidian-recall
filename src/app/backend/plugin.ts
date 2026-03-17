import { Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { Container } from './container';
import { createObsidianFilePort, createReviewFilePort, getDeviceId } from './obsidian-storage';
import { CachedJsonFilePort } from './cached-json-file-port';
import { MultiDeviceReviewLog } from '@context/study/infrastructure/json-review-log';
import { VaultSync } from './vault-sync';
import { DeckBrowserView } from '@app/frontend/deck-browser-view';
import { ReviewView } from '@app/frontend/review-view';
import { VIEW_TYPE_DECK_BROWSER, VIEW_TYPE_REVIEW } from '@app/frontend/constants';
import { RecallSettings, DEFAULT_SETTINGS, RecallSettingTab } from './settings';
import { Direction } from '@context/study/domain/direction';
import { ConceptId } from '@context/concept/domain/concept-id';

export default class RecallPlugin extends Plugin {
  container!: Container;
  vaultSync!: VaultSync;
  settings!: RecallSettings;

  // Cached file ports — plugin controls batch/invalidation
  private cachedPorts!: {
    concepts: CachedJsonFilePort;
    studyItems: CachedJsonFilePort;
    decks: CachedJsonFilePort;
    syncState: CachedJsonFilePort;
  };
  private reviewLogImpl!: MultiDeviceReviewLog;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly DEBOUNCE_MS = 500;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Migrate from old locations if needed
    const hasNewData = await this.hasRecallData();
    if (!hasNewData) {
      await this.migrateOldData();
    }

    const deviceId = await getDeviceId(this.app);

    // Create cached file ports — repos see JsonFilePort, plugin controls cache
    this.cachedPorts = {
      concepts: new CachedJsonFilePort(createObsidianFilePort(this.app, 'concepts.json')),
      studyItems: new CachedJsonFilePort(createObsidianFilePort(this.app, 'study-items.json')),
      decks: new CachedJsonFilePort(createObsidianFilePort(this.app, 'decks.json')),
      syncState: new CachedJsonFilePort(createObsidianFilePort(this.app, 'sync-state.json')),
    };

    this.reviewLogImpl = new MultiDeviceReviewLog(createReviewFilePort(this.app, deviceId));

    this.container = new Container({
      concepts: this.cachedPorts.concepts,
      studyItems: this.cachedPorts.studyItems,
      decks: this.cachedPorts.decks,
      reviewLog: this.reviewLogImpl,
      syncState: this.cachedPorts.syncState,
    });
    this.container.settings = this.settings;
    this.container.saveSettingsQuiet = async () => {
      await this.saveData(this.settings);
    };
    this.vaultSync = new VaultSync(this.container);
    this.vaultSync.setCachedPorts(this.cachedPorts);
    this.vaultSync.setReviewLog(this.reviewLogImpl);
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

    // Command to force rebuild (for first setup or troubleshooting)
    this.addCommand({
      id: 'rebuild-index',
      name: 'Rebuild index from vault',
      callback: async () => {
        await this.vaultSync.resetAll();
        await this.initialSync();
        // Refresh deck browser
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_DECK_BROWSER);
        for (const leaf of leaves) {
          const view = leaf.view as DeckBrowserView;
          if (view.render) await view.render();
        }
      },
    });

    // Settings tab
    this.addSettingTab(new RecallSettingTab(this.app, this));

    // Pass settings to VaultSync for tag filtering
    this.vaultSync.setAllowedTags(this.settings.flashcardTags);

    // Load existing sync state
    await this.vaultSync.initialize();

    // Wait for vault to be ready before loading
    this.app.workspace.onLayoutReady(async () => {
      const hasData = await this.hasRecallData();
      if (!hasData) {
        // No recall-data/ directory — waiting for Sync or first setup
        return;
      }

      // Always do incremental sync for new/changed notes
      const existingItems = await this.container.studyItemRepository.findAll();
      if (existingItems.length === 0) {
        await this.initialSync();
      }
    });

    // Listen for file system changes (includes Sync updates)
    // 'raw' event fires for ANY file change, including recall-data/
    (this.app.vault as any).on('raw', (path: string) => {
      if (path.startsWith('recall-data/') && path.endsWith('.json')) {
        this.onDataFileChanged(path);
      }
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
            () => { /* skip files that fail to rename */ },
          );
        }
      }),
    );
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
      await this.vaultSync.resetKeepReviews();
      await this.initialSync();
      await this.container.replayReviews.execute();
    }

    // Refresh deck browser if open
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_DECK_BROWSER);
    for (const leaf of leaves) {
      const view = leaf.view as DeckBrowserView;
      if (view.render) await view.render();
    }
  }

  /**
   * Import scheduling data from Spaced Repetition plugin comments.
   * Walks all synced files, parses <!--SR:!date,interval,ease-->,
   * and updates StudyItem MemoryState for items still at reps=0.
   * Returns count of imported items.
   */
  async importFromSR(): Promise<number> {
    let imported = 0;
    const files = this.app.vault.getMarkdownFiles();

    for (const file of files) {
      try {
        const content = await this.app.vault.cachedRead(file);
        const cards = this.container.parser.parse(content, file.path);

        for (const card of cards) {
          if (!card.schedulingMetadata) continue;

          // Find the concept for this card
          const key = JSON.stringify([card.sideA, card.sideB, card.directionality]);
          const conceptId = this.vaultSync.findConceptIdByCardKey(file.path, key);
          if (!conceptId) continue;

          // Find study items for this concept
          const studyItems = await this.container.studyItemRepository.findByConceptId(
            new ConceptId(conceptId),
          );

          for (const si of studyItems) {
            const schedule = si.direction === Direction.AtoB
              ? card.schedulingMetadata.aToB
              : card.schedulingMetadata.bToA;

            if (!schedule) continue;

            const result = await this.container.importSrData.execute(si.id.value, {
              due: schedule.due,
              interval: schedule.interval,
              ease: schedule.ease,
            });
            if (result) imported++;
          }
        }
      } catch {
        // Skip files that fail SR import
      }
    }

    return imported;
  }

  async rebuildIndex(): Promise<void> {
    // Reset items/decks but keep reviews (source of truth)
    await this.vaultSync.resetKeepReviews();
    // Rebuild from vault notes (creates fresh items with reps=0)
    await this.initialSync();
    // Replay reviews to restore MemoryState from the log
    await this.container.replayReviews.execute();
    // Refresh UI
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_DECK_BROWSER);
    for (const leaf of leaves) {
      const view = leaf.view as DeckBrowserView;
      if (view.render) await view.render();
    }
  }

  /**
   * Check if current IDs are deterministic by comparing a sample item's
   * actual ID with what it should be based on its content.
   */

  private dataChangeTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Called when a file in recall-data/ changes (via Sync or local write).
   * Debounced to avoid thrashing during bulk updates.
   */
  private onDataFileChanged(_path: string): void {
    // Debounce: wait 1s after last change before invalidating
    if (this.dataChangeTimer) clearTimeout(this.dataChangeTimer);
    this.dataChangeTimer = setTimeout(() => {
      this.cachedPorts.concepts.invalidate();
      this.cachedPorts.studyItems.invalidate();
      this.cachedPorts.decks.invalidate();
      this.cachedPorts.syncState.invalidate();
      this.reviewLogImpl.invalidateCache();
      this.refreshDeckBrowser();
    }, 1000);
  }

  private refreshDeckBrowser(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_DECK_BROWSER);
    for (const leaf of leaves) {
      const view = leaf.view as DeckBrowserView;
      if (view.refresh) view.refresh();
    }
  }

  private async hasRecallData(): Promise<boolean> {
    try {
      await this.app.vault.adapter.stat('recall-data/study-items.json');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * One-time migration from old storage locations to recall-data/.
   */
  private async migrateOldData(): Promise<void> {
    const newDir = 'recall-data';
    const dataFiles = ['concepts.json', 'study-items.json', 'decks.json', 'sync-state.json'];
    const oldDirs = [
      '.obsidian/plugins/obsidian-recall/data',
      '.recall',
    ];

    for (const oldDir of oldDirs) {
      let hasData = false;
      for (const file of dataFiles) {
        try {
          await this.app.vault.adapter.stat(`${oldDir}/${file}`);
          hasData = true;
          break;
        } catch { /* doesn't exist */ }
      }
      if (!hasData) continue;

      try { await this.app.vault.adapter.mkdir(newDir); } catch { /* exists */ }

      // Migrate data files
      for (const file of dataFiles) {
        try {
          const content = await this.app.vault.adapter.read(`${oldDir}/${file}`);
          await this.app.vault.adapter.write(`${newDir}/${file}`, content);
          await this.app.vault.adapter.remove(`${oldDir}/${file}`);
        } catch { /* skip */ }
      }

      // Migrate review files (reviews.json + reviews-*.json)
      try {
        const listing = await this.app.vault.adapter.list(oldDir);
        for (const file of listing.files) {
          const filename = file.split('/').pop()!;
          if (filename.startsWith('reviews')) {
            try {
              const content = await this.app.vault.adapter.read(file);
              await this.app.vault.adapter.write(`${newDir}/${filename}`, content);
              await this.app.vault.adapter.remove(file);
            } catch { /* skip */ }
          }
        }
      } catch { /* dir doesn't exist */ }

      // Clean up old dir
      try { await this.app.vault.adapter.rmdir(oldDir, false); } catch { /* not empty */ }
      break; // only migrate from the first found location
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
  }

  private async initialSync(): Promise<void> {
    await this.vaultSync.beginBatch();
    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      try {
        const content = await this.app.vault.cachedRead(file);
        await this.vaultSync.syncFile(file.path, content);
      } catch {
        // Skip files that fail to sync
      }
    }
    await this.vaultSync.endBatch();
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
        } catch {
          // Skip files that fail to sync
        }
      }, RecallPlugin.DEBOUNCE_MS),
    );
  }
}
