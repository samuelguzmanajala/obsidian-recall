import { isBackendConfigured, type PluginSettings } from './plugin-settings';
import type { ReviewCommand, SourceLocation, StudyClient } from './study-client';
import type { DueStudyItemView } from '../../context/study/application/study-item-view';
import type { SerializedSyncState } from '../../context/shared/infrastructure/json-storage';
import type { Rating } from '../../context/study/domain/rating';

export class RemoteError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export interface RemoteNote { path: string; revision: number; deleted: boolean; hash: string | null }
export type PendingReview = { studyItemId: string; operationId: string; expectedRevision: number; rating: Rating };
export interface ReviewJournal { load(): PendingReview[]; save(commands: PendingReview[]): void }
type WireItem = Omit<DueStudyItemView, 'due' | 'lastReview'> & {
  due: string; lastReview: string | null; revision: number;
  source: SourceLocation | null;
};
export class RemoteClient implements StudyClient {
  /** Persists sidebar state; wired by the plugin. */
  persistExpandedDecks: ((ids: string[]) => Promise<void>) | null = null;
  private revisions = new Map<string, number>();
  private pending = new Map<string, PendingReview>();
  private sources = new Map<string, SourceLocation>();
  private listeners = new Set<() => void>();
  private closed = false;
  close(): void { this.closed = true; this.listeners.clear(); }
  onChange = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  notifyChanged(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { console.warn('Recall: a view could not refresh'); }
    }
  }
  hasPendingReview = (): boolean => this.pending.size > 0;
  retryPendingReviews = async (): Promise<void> => {
    for (const command of [...this.pending.values()]) await this.reviewStudyItem.execute(command);
  };
  isConfigured(): boolean { return isBackendConfigured(this.settings); }
  constructor(public settings: PluginSettings, private transport: typeof fetch = fetch, private journal?: ReviewJournal) {
    for (const command of journal?.load() ?? []) {
      if (!command.operationId || !command.studyItemId || !Number.isInteger(command.expectedRevision)
        || !['again', 'hard', 'good', 'easy'].includes(command.rating)) throw new Error('Invalid pending review journal; restore it before continuing');
      this.pending.set(`${command.studyItemId}:${command.expectedRevision}`, command);
    }
  }
  private savePending(): void {
    if (this.closed) throw new Error('Recall client closed; journal retained for recovery');
    this.journal?.save([...this.pending.values()]);
  }
  async request<T>(path: string, body?: unknown): Promise<T> {
    if (this.closed) throw new Error('Recall client closed; pending operations will resume on reload');
    const config = this.settings.backend;
    if (!this.isConfigured()) throw new Error('Configure the Recall backend URL and token');
    const base = config.url.replace(/\/+$/, '');
    const parsed = new URL(base);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid backend URL');
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('Backend connection timed out. Retry to confirm the result.'));
      }, 15_000);
    });
    try {
      const response = await Promise.race([this.transport(`${base}/api/v1${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), timedOut]);
      const result = await Promise.race([response.json(), timedOut]);
      if (this.closed) throw new Error('Recall client closed; acknowledgement retained for recovery');
      if (!response.ok) throw new RemoteError(response.status, result.error ?? `HTTP ${response.status}`);
      return result as T;
    } finally { clearTimeout(timeout!); }
  }
  private async due(deckId?: string): Promise<DueStudyItemView[]> {
    const result = await this.request<{ items: WireItem[] }>(`/due?limit=10000${deckId ? `&deckId=${encodeURIComponent(deckId)}` : ''}`);
    return result.items.map(item => {
      this.revisions.set(item.studyItemId, item.revision);
      if (item.source) this.sources.set(item.conceptId, item.source);
      return { ...item, due: new Date(item.due), lastReview: item.lastReview ? new Date(item.lastReview) : null };
    });
  }
  getDueStudyItems: StudyClient['getDueStudyItems'] = { execute: () => this.due() };
  getDueStudyItemsByDeck: StudyClient['getDueStudyItemsByDeck'] = { execute: id => this.due(id) };
  getDeckTree: StudyClient['getDeckTree'] = { execute: async () => {
    const [result, state] = await Promise.all([
      this.request<{ decks: Awaited<ReturnType<StudyClient['getDeckTree']['execute']>> }>('/decks'),
      this.request<SerializedSyncState>('/sources'),
    ]);
    this.sources.clear();
    for (const [filePath, index] of Object.entries(state.fileIndices)) {
      for (const conceptId of Object.values(index.cardKeys)) this.sources.set(conceptId, { filePath, line: index.conceptLines?.[conceptId] ?? 1 });
    }
    return result.decks;
  } };
  getStudyStats: StudyClient['getStudyStats'] = { execute: () => this.request('/stats') };
  getLeeches: StudyClient['getLeeches'] = { execute: () => this.request('/leeches') };
  reviewStudyItem: StudyClient['reviewStudyItem'] = { execute: async (command: ReviewCommand): Promise<void> => {
    const expectedRevision = command.expectedRevision ?? this.revisions.get(command.studyItemId);
    if (expectedRevision === undefined) throw new Error('Refresh this card before reviewing');
    const pendingKey = `${command.studyItemId}:${expectedRevision}`;
    let pending = this.pending.get(pendingKey);
    if (!pending) {
      pending = { studyItemId: command.studyItemId, operationId: crypto.randomUUID(), expectedRevision, rating: command.rating };
      this.pending.set(pendingKey, pending);
    }
    // If an acknowledgement was lost, retry the SAME decision, not a new rating.
    this.savePending(); // Storage failure must prevent sending an unjournaled command.
    const result = await this.request<{ applied: number; errors: { reason: string; status: number }[] }>('/reviews', {
      reviews: [pending],
    });
    if (result.errors.length) {
      this.pending.delete(pendingKey);
      this.savePending();
      throw new RemoteError(result.errors[0].status, result.errors[0].reason);
    }
    if (result.applied !== 1) throw new Error('Backend did not acknowledge the review');
    this.pending.delete(pendingKey);
    this.savePending();
    this.notifyChanged();
  } };
  findSource(conceptId: string): SourceLocation | null { return this.sources.get(conceptId) ?? null; }
  get expandedDeckIds(): readonly string[] { return this.settings.expandedDeckIds; }
  toggleDeckExpanded(deckId: string): void {
    const ids = this.settings.expandedDeckIds;
    const idx = ids.indexOf(deckId);
    if (idx >= 0) ids.splice(idx, 1);
    else ids.push(deckId);
    void this.persistExpandedDecks?.([...ids]);
  }
}
