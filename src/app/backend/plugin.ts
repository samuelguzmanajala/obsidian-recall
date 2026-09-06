import { Plugin, TFile, WorkspaceLeaf, Notice } from 'obsidian';
import { RemoteClient } from './remote-client';
import { RemoteNoteSync } from './remote-note-sync';
import { Container } from './container';
import { createJsonFileStorage, createReviewDeviceStorage, getDeviceId } from './obsidian-storage';
import { CachedJsonFileStorage } from './cached-json-file-storage';
import { MultiDeviceReviewLog } from '@context/study/infrastructure/json-review-log';
import { VaultSync } from './vault-sync';
import { DeckBrowserView } from '@app/frontend/deck-browser-view';
import { ReviewView } from '@app/frontend/review-view';
import { VIEW_TYPE_DECK_BROWSER, VIEW_TYPE_REVIEW } from '@app/frontend/constants';
import { RecallSettings, DEFAULT_SETTINGS, RecallSettingTab } from './settings';
import { Direction } from '@context/study/domain/direction';
import { ConceptId } from '@context/concept/domain/concept-id';
import { VoiceApiServer } from './voice-api/voice-api-server';
import { TtsCache } from './voice-api/tts-cache';
import { LlmRewriter, REWRITER_SYSTEM_PROMPT } from './voice-api/llm-rewriter';
import { createBinaryFileStorage, createTextFileStorage } from './obsidian-storage';
import { obsidianFetch } from './obsidian-fetch';
import { SyncLogger } from './sync-logger';

export default class RecallPlugin extends Plugin {
  private remoteClient: RemoteClient | null = null;
  private remoteSync: RemoteNoteSync | null = null;
  isRemoteMode(): boolean { return this.remoteClient !== null; }
  container!: Container;
  vaultSync!: VaultSync;
  settings!: RecallSettings;

  // Cached file ports — plugin controls batch/invalidation
  private cachedPorts!: {
    concepts: CachedJsonFileStorage;
    studyItems: CachedJsonFileStorage;
    decks: CachedJsonFileStorage;
    syncState: CachedJsonFileStorage;
  };
  private reviewLogImpl!: MultiDeviceReviewLog;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private voiceApiServer: VoiceApiServer | null = null;
  private ttsCache: TtsCache | null = null;
  private previousVoiceApiKey = '';
  private previousVoiceTtsKey = '';
  private static readonly DEBOUNCE_MS = 500;

  private async loadRemote(): Promise<void> {
    // Capture connection settings until reload so a pending command cannot switch servers.
    const client = new RemoteClient(structuredClone(this.settings), obsidianFetch);
    this.remoteClient = client;
    client.saveSettingsQuiet = async () => {
      this.settings.expandedDeckIds = client.settings.expandedDeckIds;
      await this.saveData(this.settings);
    };
    this.registerView(VIEW_TYPE_DECK_BROWSER, leaf => new DeckBrowserView(leaf, client));
    this.registerView(VIEW_TYPE_REVIEW, leaf => new ReviewView(leaf, client));
    this.addRibbonIcon('brain', 'Recall', () => this.activateDeckBrowser());
    this.addCommand({ id: 'open-deck-browser', name: 'Open deck browser', callback: () => this.activateDeckBrowser() });
    this.addCommand({ id: 'start-review', name: 'Start review', callback: () => this.openReview() });
    this.addSettingTab(new RecallSettingTab(this.app, this));
    if (!client.settings.backend?.syncNotes) return;

    const key = `recall-note-cursors:${this.app.vault.getName()}:${client.settings.backend.url}`;
    let state = {};
    try { state = JSON.parse(localStorage.getItem(key) ?? '{}'); } catch { /* first run */ }
    this.remoteSync = new RemoteNoteSync(client, state, value => localStorage.setItem(key, JSON.stringify(value)));
    // Serialize file reads with rename/delete events, not just their HTTP requests.
    let publicationTail = Promise.resolve();
    const enqueue = (work: () => Promise<void>) => {
      publicationTail = publicationTail.then(work).catch(error => new Notice(`Recall sync: ${error.message}`, 10000)).then(() => {});
      return publicationTail;
    };
    const publishNow = async (file: TFile, path: string) => {
      if (file.extension !== 'md') return;
      if (file.path !== path) return;
      const content = await this.app.vault.read(file);
      if (file.path !== path) return;
      await this.remoteSync!.publish(path, content);
    };
    const publish = (file: TFile) => { const path = file.path; return enqueue(() => publishNow(file, path)); };
    this.registerEvent(this.app.vault.on('create', file => { if (file instanceof TFile) void publish(file); }));
    this.registerEvent(this.app.vault.on('modify', file => { if (file instanceof TFile) void publish(file); }));
    this.registerEvent(this.app.vault.on('delete', file => {
      if (file instanceof TFile && file.extension === 'md') {
        const path = file.path;
        void enqueue(() => this.remoteSync!.publish(path, null));
      }
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFile && file.extension === 'md') {
        const path = file.path;
        void enqueue(async () => {
          await this.remoteSync!.rename(oldPath, path);
          await publishNow(file, path);
        });
      }
    }));
    this.addCommand({ id: 'publish-notes', name: 'Publish notes to backend', callback: async () => {
      for (const file of this.app.vault.getMarkdownFiles()) await publish(file);
      new Notice('Recall: publishing finished. Any conflicts were reported; no local notes were modified.');
    } });
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    if (this.settings.backend?.enabled) {
      await this.loadRemote();
      return; // No local stores, replay, migrations or embedded server in remote mode.
    }

    // Migrate from old locations if needed
    const hasNewData = await this.hasRecallData();
    if (!hasNewData) {
      await this.migrateOldData();
    }

    const deviceId = await getDeviceId(this.app);

    // Create cached file ports — repos see JsonFileStorage, plugin controls cache
    this.cachedPorts = {
      concepts: new CachedJsonFileStorage(createJsonFileStorage(this.app, 'concepts.json')),
      studyItems: new CachedJsonFileStorage(createJsonFileStorage(this.app, 'study-items.json')),
      decks: new CachedJsonFileStorage(createJsonFileStorage(this.app, 'decks.json')),
      syncState: new CachedJsonFileStorage(createJsonFileStorage(this.app, 'sync-state.json')),
    };

    this.reviewLogImpl = new MultiDeviceReviewLog(createReviewDeviceStorage(this.app, deviceId));

    this.container = new Container({
      concepts: this.cachedPorts.concepts,
      studyItems: this.cachedPorts.studyItems,
      decks: this.cachedPorts.decks,
      reviewLog: this.reviewLogImpl,
      syncState: this.cachedPorts.syncState,
    }, obsidianFetch);
    this.container.settings = this.settings;
    this.container.saveSettingsQuiet = async () => {
      await this.saveData(this.settings);
    };
    this.vaultSync = new VaultSync(this.container);
    this.vaultSync.setCachedPorts(this.cachedPorts);
    this.vaultSync.setReviewLog(this.reviewLogImpl);
    this.vaultSync.setLogger(new SyncLogger(this.app));
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
      // Detach any duplicate views Obsidian may have restored from a saved
      // layout (occasionally the deck browser ends up registered twice in
      // the sidebar after a reload). Keep the first leaf, drop the rest.
      this.detachDuplicateLeaves(VIEW_TYPE_DECK_BROWSER);
      this.detachDuplicateLeaves(VIEW_TYPE_REVIEW);

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

    this.previousVoiceApiKey = this.voiceApiKey();
    this.previousVoiceTtsKey = this.voiceTtsKey();
    await this.startVoiceApiIfEnabled();
  }

  private voiceApiKey(): string {
    const v = this.settings.voiceApi;
    return `${v.enabled}|${v.port}|${v.bindAddress}|${v.token}`;
  }

  private voiceTtsKey(): string {
    const v = this.settings.voiceTts;
    return `${v.enabled}|${v.voice}|${v.model}|${v.instructions}|${v.llmPreprocess}|${v.apiKey ? 'set' : ''}`;
  }

  private buildTtsCache(): TtsCache | null {
    if (!this.settings.voiceTts.enabled) return null;
    const storage = createBinaryFileStorage(this.app);
    const cfg = this.settings.voiceTts;
    return new TtsCache(
      storage,
      this.container.ttsClient,
      'recall-data/voice-cache',
      cfg.voice,
      cfg.model || 'gpt-4o-mini-tts',
      cfg.instructions || '',
    );
  }

  private buildRewriter(): LlmRewriter | null {
    if (!this.settings.voiceTts.llmPreprocess) return null;
    if (!this.container.llmClient.isConfigured()) return null;
    const storage = createTextFileStorage(this.app);
    return new LlmRewriter(this.container.llmClient, storage);
  }

  private async startVoiceApiIfEnabled(): Promise<void> {
    if (!this.settings.voiceApi.enabled) return;
    if (!this.settings.voiceApi.token) {
      console.warn('[Recall API] enabled but no token set — server not started.');
      return;
    }
    try {
      this.ttsCache = this.buildTtsCache();
      const rewriter = this.buildRewriter();
      this.voiceApiServer = new VoiceApiServer(this.container, this.settings, {
        ttsCache: this.ttsCache,
        rewriter,
        isTtsConfigured: () =>
          this.settings.voiceTts.enabled && this.container.ttsClient.isConfigured(),
      });
      await this.voiceApiServer.start();
    } catch (err) {
      console.error('[Recall API] failed to start:', err);
      this.voiceApiServer = null;
    }
  }

  /**
   * Sanity-check the configured LLM by running the rewriter prompt against
   * a sample multilingual card. Returns the rewritten text on success, or
   * a string starting with "Error:" on failure.
   */
  async testLlm(): Promise<{ ok: true; original: string; rewritten: string } | { ok: false; error: string }> {
    if (!this.container.llmClient.isConfigured()) {
      return { ok: false, error: 'LLM provider or API key not set in AI Integration.' };
    }
    const original = 'neglect (No ___ tu salud)';
    try {
      const response = await this.container.llmClient.complete([
        { role: 'system', content: REWRITER_SYSTEM_PROMPT },
        { role: 'user', content: original },
      ]);
      const rewritten = response.content.trim();
      if (!rewritten) return { ok: false, error: 'LLM returned an empty response.' };
      return { ok: true, original, rewritten };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * Synthesize a short test phrase. Returns null on success, or a human
   * readable error message on failure. Used by the "Test TTS" button.
   */
  async testTts(): Promise<string | null> {
    if (!this.container.ttsClient.isConfigured()) {
      return 'API key not set';
    }
    try {
      const cfg = this.settings.voiceTts;
      const audio = await this.container.ttsClient.synthesize({
        text: 'Hola, esto es una prueba de Recall en español, English, und Deutsch.',
        voice: cfg.voice || 'alloy',
        model: cfg.model || 'gpt-4o-mini-tts',
        instructions: cfg.instructions || undefined,
        format: 'mp3',
      });
      return audio.length > 0 ? null : 'empty audio response';
    } catch (err) {
      return (err as Error).message;
    }
  }

  /** Stop and re-start the voice API server (used by settings UI). */
  async restartVoiceApi(): Promise<void> {
    if (this.voiceApiServer) {
      await this.voiceApiServer.stop();
      this.voiceApiServer = null;
    }
    this.ttsCache = null;
    await this.startVoiceApiIfEnabled();
    this.previousVoiceApiKey = this.voiceApiKey();
    this.previousVoiceTtsKey = this.voiceTtsKey();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.previousTags = [...this.settings.flashcardTags];
  }

  private previousTags: string[] = [];

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    if (this.remoteClient) return;
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

    // Restart voice API if its config OR TTS config changed
    const newVoiceApiKey = this.voiceApiKey();
    const newVoiceTtsKey = this.voiceTtsKey();
    if (
      newVoiceApiKey !== this.previousVoiceApiKey ||
      newVoiceTtsKey !== this.previousVoiceTtsKey
    ) {
      this.previousVoiceApiKey = newVoiceApiKey;
      this.previousVoiceTtsKey = newVoiceTtsKey;
      await this.restartVoiceApi();
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

  /**
   * Drop all but the first leaf of [viewType]. Obsidian sometimes restores
   * the saved layout with two copies of a single-instance view after a
   * reload, which leads to duplicated content stacked in the same panel.
   */
  private detachDuplicateLeaves(viewType: string): void {
    const leaves = this.app.workspace.getLeavesOfType(viewType);
    for (let i = 1; i < leaves.length; i++) {
      leaves[i].detach();
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
    if (this.voiceApiServer) {
      void this.voiceApiServer.stop();
      this.voiceApiServer = null;
    }
  }

  private async initialSync(): Promise<void> {
    await this.vaultSync.beginBatch();
    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      try {
        const content = await this.app.vault.cachedRead(file);
        await this.vaultSync.syncFile(file.path, content);
      } catch (err) {
        console.error('[Recall] initial sync failed for file:', file.path, err);
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
