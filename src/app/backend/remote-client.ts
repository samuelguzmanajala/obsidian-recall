import type { RecallSettings } from './recall-settings';
import type { StudyClient } from './study-client';
import type { DueStudyItemView } from '../../context/study/application/study-item-view';
import type { SerializedSyncState } from '../../context/shared/infrastructure/json-storage';
import type { ReviewStudyItemCommand } from '../../context/study/application/review-study-item';

export class RemoteError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export interface RemoteNote { path: string; revision: number; deleted: boolean; hash: string | null }
type WireItem = Omit<DueStudyItemView, 'due' | 'lastReview'> & {
  due: string; lastReview: string | null; revision: number;
  source: { filePath: string; line: number } | null;
};
export class RemoteClient implements StudyClient {
  readonly remote = true;
  saveSettingsQuiet: (() => Promise<void>) | null = null;
  private revisions = new Map<string, number>();
  private pending = new Map<string, { operationId: string; expectedRevision: number; rating: string }>();
  private sources = new Map<string, { filePath: string; line: number }>();
  constructor(public settings: RecallSettings, private transport: typeof fetch = fetch) {}
  async request<T>(path: string, body?: unknown): Promise<T> {
    const config = this.settings.backend;
    if (!config?.url || !config.token) throw new Error('Configure the Recall backend URL and token');
    const base = config.url.replace(/\/+$/, '');
    const parsed = new URL(base);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid backend URL');
    const response = await this.transport(`${base}/api/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) throw new RemoteError(response.status, result.error ?? `HTTP ${response.status}`);
    return result as T;
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
  reviewStudyItem = { execute: async (command: ReviewStudyItemCommand): Promise<void> => {
    const expectedRevision = command.expectedRevision ?? this.revisions.get(command.studyItemId);
    if (expectedRevision === undefined) throw new Error('Refresh this card before reviewing');
    const pendingKey = `${command.studyItemId}:${expectedRevision}`;
    let pending = this.pending.get(pendingKey);
    if (!pending) {
      pending = { operationId: crypto.randomUUID(), expectedRevision, rating: command.rating };
      this.pending.set(pendingKey, pending);
    }
    // If an acknowledgement was lost, retry the SAME decision, not a new rating.
    const result = await this.request<{ applied: number; errors: { reason: string; status: number }[] }>('/reviews', {
      reviews: [{ studyItemId: command.studyItemId, ...pending }],
    });
    if (result.errors.length) {
      this.pending.delete(pendingKey);
      throw new RemoteError(result.errors[0].status, result.errors[0].reason);
    }
    if (result.applied !== 1) throw new Error('Backend did not acknowledge the review');
    this.pending.delete(pendingKey);
  } };
  // Remote refresh uses a new server queue, never client-side domain reconstruction.
  studyItemRepository = { findById: async () => null };
  conceptRepository = { findById: async () => null };
  vaultSync = { findFileByConceptId: (id: string) => this.sources.get(id) ?? null };
}
