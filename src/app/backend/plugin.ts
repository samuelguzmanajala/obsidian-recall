import { Plugin, TFile, Notice, Modal } from 'obsidian';
import { RemoteClient } from './remote-client';
import { RemoteNoteSync } from './remote-note-sync';
import { KeyDebouncer } from './key-debouncer';
import { DeckBrowserView } from '@app/frontend/deck-browser-view';
import { ReviewView } from '@app/frontend/review-view';
import { VIEW_TYPE_DECK_BROWSER, VIEW_TYPE_REVIEW } from '@app/frontend/constants';
import { PluginSettings, loadPluginSettings, RecallSettingTab } from './settings';
import { obsidianFetch } from './obsidian-fetch';

/** Obsidian client of the Recall backend. Scheduling, indexing and audio live on the server. */
export default class RecallPlugin extends Plugin {
  private remoteSync: RemoteNoteSync | null = null;
  settings!: PluginSettings;

  private async connect(): Promise<void> {
    // Capture connection settings until reload so a pending command cannot switch servers.
    const scope = `${this.app.vault.getName()}:${this.settings.backend.url}`;
    const reviewKey = `recall-pending-reviews:${scope}`;
    const client = new RemoteClient(structuredClone(this.settings), obsidianFetch, {
      load: () => JSON.parse(localStorage.getItem(reviewKey) ?? '[]'),
      save: commands => localStorage.setItem(reviewKey, JSON.stringify(commands)),
    });
    client.persistExpandedDecks = async ids => {
      this.settings.expandedDeckIds = ids;
      await this.saveSettings();
    };
    this.registerView(VIEW_TYPE_DECK_BROWSER, leaf => new DeckBrowserView(leaf, client));
    this.registerView(VIEW_TYPE_REVIEW, leaf => new ReviewView(leaf, client));
    this.addRibbonIcon('brain', 'Recall', () => this.activateDeckBrowser());
    this.addCommand({ id: 'open-deck-browser', name: 'Open deck browser', callback: () => this.activateDeckBrowser() });
    this.addCommand({ id: 'start-review', name: 'Start review', callback: () => this.openReview() });
    this.addSettingTab(new RecallSettingTab(this.app, this));
    const status = this.addStatusBarItem();
    if (!client.isConfigured()) {
      // Views explain the missing configuration; nothing to recover or publish until reload.
      status.setText('Recall: configura el backend en los ajustes');
      return;
    }
    let recovering: Promise<void> | null = null;
    let disposed = false;
    const recover = (): Promise<void> => {
      if (disposed) return Promise.resolve();
      if (recovering) return recovering;
      recovering = (async () => {
        const results = await Promise.allSettled([
          client.retryPendingReviews(), this.remoteSync?.retry() ?? Promise.resolve(),
        ]);
        if (disposed) return;
        const failure = results.find(r => r.status === 'rejected');
        const pending = this.remoteSync?.pendingCount ?? 0;
        status.setText(failure ? `Recall: pendiente de sincronizar (${pending} notas)` : 'Recall: sin operaciones pendientes');
        status.setAttribute('title', failure?.status === 'rejected' ? String(failure.reason.message) : `Ultima revision de pendientes: ${new Date().toLocaleTimeString()}`);
        if (!failure) client.notifyChanged();
      })().finally(() => { recovering = null; });
      return recovering;
    };
    this.registerInterval(window.setInterval(() => void recover(), 30_000));
    this.registerDomEvent(window, 'online', () => void recover());
    this.registerDomEvent(window, 'focus', () => void recover());
    this.register(() => { disposed = true; this.remoteSync?.close(); client.close(); });
    this.addCommand({ id: 'retry-pending', name: 'Retry pending notes and reviews', callback: () => recover() });
    void recover();
    if (!client.settings.backend.syncNotes) return;

    const key = `recall-note-cursors:${this.app.vault.getName()}:${client.settings.backend.url}`;
    let state = {};
    try { state = JSON.parse(localStorage.getItem(key) ?? '{}'); } catch { /* first run */ }
    const journalKey = `recall-pending-notes:${scope}`;
    this.remoteSync = new RemoteNoteSync(client, state, value => localStorage.setItem(key, JSON.stringify(value)), {
      load: () => JSON.parse(localStorage.getItem(journalKey) ?? '[]'),
      save: jobs => localStorage.setItem(journalKey, JSON.stringify(jobs)),
    }, async path => {
      const file = this.app.vault.getAbstractFileByPath(path);
      return file instanceof TFile ? this.app.vault.read(file) : null;
    });
    this.addCommand({ id: 'resolve-note-conflict', name: 'Resolve note conflict using this vault version', callback: () => {
      const path = this.remoteSync?.conflictPath;
      if (!path) { new Notice('Recall: no hay un conflicto de contenido detectado. Reintenta la sincronizacion primero.'); return; }
      const dialog = new Modal(this.app);
      dialog.contentEl.createEl('h3', { text: 'Resolver conflicto de Recall' });
      dialog.contentEl.createEl('p', { text: `Publicar la version actual de ${path} sustituira su version en el backend. No modifica la nota del vault. Si el cambio remoto es el correcto, cancela y reconcilia primero las notas.` });
      dialog.contentEl.createEl('button', { text: 'Cancelar' }).onclick = () => dialog.close();
      dialog.contentEl.createEl('button', { text: 'Publicar version local' }).onclick = async () => {
        dialog.close();
        try {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile)) throw new Error('La nota local no esta disponible');
          await this.remoteSync!.resolveWithLocal(await this.app.vault.read(file), path);
          await recover();
        } catch (error) { new Notice(`Recall: ${(error as Error).message}`, 15000); }
      };
      dialog.open();
    } });
    // Serialize file reads with rename/delete events, not just their HTTP requests.
    let publicationTail = Promise.resolve();
    let notificationTimer: ReturnType<typeof setTimeout> | undefined;
    const notifyPublished = () => {
      clearTimeout(notificationTimer);
      notificationTimer = setTimeout(() => client.notifyChanged(), 250);
    };
    this.register(() => clearTimeout(notificationTimer));
    const enqueue = (work: () => Promise<void>) => {
      publicationTail = publicationTail.then(work).then(notifyPublished).catch(error => new Notice(`Recall sync: ${error.message}`, 10000)).then(() => {});
      return publicationTail;
    };
    const publishNow = async (file: TFile, path: string) => {
      if (file.extension !== 'md' || path.split('/').includes('node_modules')) return;
      if (file.path !== path) return;
      const content = await this.app.vault.read(file);
      if (file.path !== path) return;
      await this.remoteSync!.publish(path, content);
    };
    const publish = (file: TFile) => { const path = file.path; return enqueue(() => publishNow(file, path)); };
    this.registerEvent(this.app.vault.on('create', file => { if (file instanceof TFile) void publish(file); }));
    // Autosave fires every few seconds while typing; publish only the settled note.
    // An edit dropped on unload is picked up by the next reconcile.
    const edits = new KeyDebouncer(2000);
    this.register(() => edits.clear());
    this.registerEvent(this.app.vault.on('modify', file => {
      if (file instanceof TFile) edits.schedule(file.path, () => void publish(file));
    }));
    this.registerEvent(this.app.vault.on('delete', file => {
      if (file instanceof TFile) edits.cancel(file.path);
      if (file instanceof TFile && file.extension === 'md') {
        const path = file.path;
        this.remoteSync!.stageDelete(path);
        void enqueue(() => this.remoteSync!.retry());
      }
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      edits.cancel(oldPath);
      if (file instanceof TFile && oldPath.endsWith('.md') && file.extension !== 'md') {
        this.remoteSync!.stageDelete(oldPath);
        void enqueue(() => this.remoteSync!.retry());
      } else if (file instanceof TFile && file.extension === 'md' && !oldPath.endsWith('.md')) {
        void publish(file);
      } else if (file instanceof TFile && file.extension === 'md') {
        const path = file.path;
        this.remoteSync!.stageRename(oldPath, path);
        void enqueue(async () => {
          await this.remoteSync!.retry();
          await publishNow(file, path);
        });
      }
    }));
    this.addCommand({ id: 'publish-notes', name: 'Publish notes to backend', callback: async () => {
      await reconcile();
    } });
    let reconcileQueued = false;
    let lastReconcileAt = 0;
    const reconcile = () => {
      if (reconcileQueued || disposed) return publicationTail;
      reconcileQueued = true;
      lastReconcileAt = Date.now();
      return enqueue(async () => {
        const files = this.app.vault.getMarkdownFiles().filter(file => !file.path.split('/').includes('node_modules'));
        await this.remoteSync!.batch(async () => {
          for (const file of files) {
            const path = file.path;
            const content = await this.app.vault.read(file);
            if (path === file.path) await this.remoteSync!.stageCurrent(path, content);
          }
        });
        const localPaths = new Set(files.map(file => file.path));
        const missing = this.remoteSync!.knownPaths.filter(path => !path.split('/').includes('node_modules') && !localPaths.has(path));
        if (missing.length) new Notice(`Recall: ${missing.length} notas conocidas no estan presentes. No se han borrado sus tarjetas; revisa la sincronizacion del vault.`, 15000);
        await recover();
      }).finally(() => { reconcileQueued = false; });
    };
    // File watcher events can be missed during long-running sessions, especially
    // when another process updates many files on an external volume.
    this.registerInterval(window.setInterval(() => void reconcile(), 10 * 60_000));
    this.registerDomEvent(window, 'focus', () => {
      if (Date.now() - lastReconcileAt >= 2 * 60_000) void reconcile();
    });
    this.app.workspace.onLayoutReady(() => { if (!disposed) void reconcile(); });
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.connect();
  }

  async loadSettings(): Promise<void> {
    this.settings = loadPluginSettings(await this.loadData());
  }

  /** Connection changes are applied on the next plugin load. */
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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
}
