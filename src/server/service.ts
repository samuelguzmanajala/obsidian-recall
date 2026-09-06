import { createHash } from 'node:crypto';
import { Container } from '../app/backend/container';
import { VaultSync } from '../app/backend/vault-sync';
import { DEFAULT_SETTINGS, type RecallSettings } from '../app/backend/recall-settings';
import { MultiDeviceReviewLog } from '../context/study/infrastructure/json-review-log';
import type { SerializedReview, SerializedSyncState } from '../context/shared/infrastructure/json-storage';
import { StudyItemId } from '../context/study/domain/study-item-id';
import { Rating } from '../context/study/domain/rating';
import { Direction } from '../context/study/domain/direction';
import { markdownToVoice } from '../app/backend/voice-api/markdown-to-voice';
import { RecallDatabase } from './database';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Expected an object');
  return value as Record<string, unknown>;
}
export function string(value: unknown, name: string, max = 1024): string {
  if (typeof value !== 'string' || !value.length || value.length > max) throw new ApiError(400, `Invalid ${name}`);
  return value;
}
export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ApiError(400, 'expectedRevision is required');
  return value as number;
}
function notePath(value: unknown): string {
  const path = string(value, 'path');
  if (!path.endsWith('.md') || path.startsWith('/') || path.includes('\\') || path.split('/').some(p => p === '..' || p === '.' || !p)) throw new ApiError(400, 'Expected a vault-relative Markdown path');
  return path;
}

/** Uses the existing domain through transactional ports; no Obsidian runtime or vault filesystem. */
export class RecallService {
  readonly settings: RecallSettings;
  constructor(readonly db: RecallDatabase, settings: Partial<RecallSettings> = {}) {
    this.settings = { ...structuredClone(DEFAULT_SETTINGS), ...settings };
  }
  async context(): Promise<Container> {
    const reviews = this.db.document('reviews');
    const read = async () => await reviews.read<SerializedReview[]>() ?? [];
    const container = new Container({
      concepts: this.db.document('concepts'), studyItems: this.db.document('study-items'),
      decks: this.db.document('decks'), syncState: this.db.document('sync-state'),
      reviewLog: new MultiDeviceReviewLog({ readLocal: read, readAll: read, writeLocal: v => reviews.write(v) }),
    });
    container.settings = this.settings;
    container.vaultSync = new VaultSync(container);
    container.vaultSync.setAllowedTags(this.settings.flashcardTags);
    await container.vaultSync.initialize();
    return container;
  }
  query<T>(work: (c: Container) => Promise<T>): Promise<T> {
    return this.db.transaction(async () => work(await this.context()));
  }
  async reindexIfTagsChanged(): Promise<void> {
    await this.db.transaction(async () => {
      const config = this.db.document('index-tags');
      if (JSON.stringify(await config.read()) === JSON.stringify(this.settings.flashcardTags)) return;
      const c = await this.context();
      const affected = new Set((await c.studyItemRepository.findAll()).map(i => i.id.value));
      const notes = this.db.sql.prepare('SELECT path,content FROM notes WHERE content IS NOT NULL').all();
      for (const note of notes) await c.vaultSync!.syncFile(note.path as string, note.content as string);
      for (const item of await c.studyItemRepository.findAll()) affected.add(item.id.value);
      if (notes.length) for (const id of affected) await this.db.document(`revision:${id}`).write(this.itemRevision(id) + 1);
      await config.write(this.settings.flashcardTags);
    });
  }
  private async allowance(c: Container) {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const key = `budget:${start.toISOString()}`;
    const stored = await this.db.document(key).read<{ introduced: number; reviewed: number }>();
    const reviews = await c.reviewLog.findAll();
    const first = new Map<string, Date>();
    for (const r of reviews) {
      const existing = first.get(r.studyItemId.value);
      if (!existing || r.timestamp < existing) first.set(r.studyItemId.value, r.timestamp);
    }
    const introduced = stored?.introduced ?? [...first.values()].filter(t => t >= start).length;
    const reviewed = stored?.reviewed ?? reviews.filter(r => r.timestamp >= start).length - introduced;
    return {
      key, introduced, reviewed,
      newLeft: this.settings.dailyNewLimit === 0 ? Infinity : Math.max(0, this.settings.dailyNewLimit - introduced),
      reviewLeft: this.settings.dailyReviewLimit === 0 ? Infinity : Math.max(0, this.settings.dailyReviewLimit - reviewed),
    };
  }
  async due(deckId?: string, limit = 50) {
    return this.query(async c => {
      const { newLeft, reviewLeft } = await this.allowance(c);
      let newCount = 0, reviewCount = 0;
      const due = deckId
        ? await c.getDueStudyItemsByDeck.execute(deckId, new Date())
        : await c.getDueStudyItems.execute(new Date());
      const items = due.filter(item => item.reps === 0 ? newCount++ < newLeft : reviewCount++ < reviewLeft);
      if (this.settings.shuffleReviews) {
        for (let i = items.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [items[i], items[j]] = [items[j], items[i]];
        }
      }
      return { items: items.slice(0, limit).map(item => ({
        ...item, revision: this.itemRevision(item.studyItemId),
        source: c.vaultSync!.findFileByConceptId(item.conceptId),
        voiceQuestion: markdownToVoice(item.direction === Direction.AtoB ? item.sideA : item.sideB),
        voiceAnswer: markdownToVoice(item.direction === Direction.AtoB ? item.sideB : item.sideA),
      })) };
    });
  }
  private itemRevision(id: string): number {
    const row = this.db.sql.prepare('SELECT value FROM documents WHERE key=?').get(`revision:${id}`);
    return row ? JSON.parse(row.value as string) as number : 0;
  }
  private async once(id: string, payload: unknown, apply: () => Promise<unknown>) {
    const canonical = JSON.stringify(payload);
    const existing = this.db.sql.prepare('SELECT payload,result FROM operations WHERE id=?').get(id);
    if (existing) {
      if (existing.payload !== canonical) throw new ApiError(409, 'operationId was already used for a different command');
      return JSON.parse(existing.result as string);
    }
    const result = await apply();
    this.db.sql.prepare('INSERT INTO operations VALUES (?,?,?)').run(id, canonical, JSON.stringify(result));
    return result;
  }
  async review(body: unknown) {
    const cmd = record(body);
    const operationId = string(cmd.operationId, 'operationId', 128);
    const studyItemId = string(cmd.studyItemId, 'studyItemId', 256);
    const expectedRevision = revision(cmd.expectedRevision);
    if (!Object.values(Rating).includes(cmd.rating as Rating)) throw new ApiError(400, 'Invalid rating');
    const rating = cmd.rating as Rating;
    return this.db.transaction(() => this.once(operationId, { type: 'review', studyItemId, rating, expectedRevision }, async () => {
      const c = await this.context();
      const item = await c.studyItemRepository.findById(new StudyItemId(studyItemId));
      if (!item) throw new ApiError(404, 'Study item no longer exists; refresh the queue');
      const current = this.itemRevision(studyItemId);
      if (current !== expectedRevision) throw new ApiError(409, 'Card reviewed or changed on another device; refresh the queue');
      const allowance = await this.allowance(c);
      if ((item.memoryState.reps === 0 ? allowance.newLeft : allowance.reviewLeft) <= 0) throw new ApiError(409, 'Daily limit reached on another device; refresh the queue');
      if (item.memoryState.due > new Date()) throw new ApiError(409, 'Card is no longer due');
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const siblings = new Set((await c.studyItemRepository.findByConceptId(item.conceptId)).filter(i => i.id.value !== studyItemId).map(i => i.id.value));
      if ((await c.reviewLog.findSince(start)).some(r => siblings.has(r.studyItemId.value))) throw new ApiError(409, 'Other direction already reviewed today; refresh the queue');
      await c.reviewStudyItem.execute({ studyItemId, rating });
      await this.db.document(allowance.key).write({
        introduced: allowance.introduced + (item.memoryState.reps === 0 ? 1 : 0),
        reviewed: allowance.reviewed + (item.memoryState.reps === 0 ? 0 : 1),
      });
      await this.db.document(`revision:${studyItemId}`).write(current + 1);
      return { studyItemId, revision: current + 1, operationId };
    }));
  }
  async note(body: unknown) {
    const cmd = record(body);
    const operationId = string(cmd.operationId, 'operationId', 128);
    const path = notePath(cmd.path);
    const expectedRevision = revision(cmd.expectedRevision);
    const content = cmd.content;
    if (content !== null && (typeof content !== 'string' || Buffer.byteLength(content) > 2_000_000)) throw new ApiError(400, 'Invalid note content');
    return this.db.transaction(() => this.once(operationId, { type: 'note', path, content, expectedRevision }, async () => {
      const old = this.db.sql.prepare('SELECT content,revision FROM notes WHERE path=?').get(path);
      const current = old ? Number(old.revision) : 0;
      // Identical content is safe to acknowledge even with a stale revision.
      if (old && old.content === content) return { path, revision: current };
      if (current !== expectedRevision) throw new ApiError(409, 'Note changed on another device; resolve content before publishing');
      const c = await this.context();
      const before = await c.syncStateFile.read<SerializedSyncState>();
      const affected = new Set(before?.fileIndices[path]?.studyItemIds ?? []);
      if (content === null) await c.vaultSync!.removeFile(path);
      else await c.vaultSync!.syncFile(path, content);
      // Invalidate queued reviews when note contents change, including remove/recreate of stable IDs.
      const after = await c.syncStateFile.read<SerializedSyncState>();
      for (const id of after?.fileIndices[path]?.studyItemIds ?? []) affected.add(id);
      for (const id of affected) await this.db.document(`revision:${id}`).write(this.itemRevision(id) + 1);
      this.db.sql.prepare('INSERT INTO notes VALUES (?,?,?) ON CONFLICT(path) DO UPDATE SET content=excluded.content,revision=excluded.revision')
        .run(path, content as string | null, current + 1);
      return { path, revision: current + 1 };
    }));
  }
  notes() {
    return this.db.transaction(async () => ({ notes: this.db.sql.prepare('SELECT path,content,revision FROM notes ORDER BY path').all().map(row => ({
      path: row.path, revision: row.revision, deleted: row.content === null,
      hash: row.content === null ? null : createHash('sha256').update(row.content as string).digest('hex'),
    })) }));
  }
  audioText(studyItemId: string, side: 'question' | 'answer') {
    return this.query(async c => {
      const item = await c.studyItemRepository.findById(new StudyItemId(studyItemId));
      if (!item) throw new ApiError(404, 'Study item not found');
      const concept = await c.conceptRepository.findById(item.conceptId);
      if (!concept) throw new ApiError(404, 'Concept not found');
      const a = (side === 'question') === (item.direction === Direction.AtoB);
      return markdownToVoice(a ? concept.sideA.content : concept.sideB.content);
    });
  }
  async renameNote(body: unknown) {
    const cmd = record(body);
    const operationId = string(cmd.operationId, 'operationId', 128);
    const path = notePath(cmd.path);
    const newPath = notePath(cmd.newPath);
    const expectedRevision = revision(cmd.expectedRevision);
    if (path === newPath) throw new ApiError(400, 'Paths must differ');
    return this.db.transaction(() => this.once(operationId, { type: 'rename', path, newPath, expectedRevision }, async () => {
      const old = this.db.sql.prepare('SELECT content,revision FROM notes WHERE path=?').get(path);
      if (!old || old.content === null) throw new ApiError(404, 'Source note not found');
      if (Number(old.revision) !== expectedRevision) throw new ApiError(409, 'Source note changed; reconcile before renaming');
      if (this.db.sql.prepare('SELECT path FROM notes WHERE path=?').get(newPath)) throw new ApiError(409, 'Target path already exists (including tombstones)');
      const c = await this.context();
      await c.vaultSync!.renameFile(path, newPath);
      this.db.sql.prepare('UPDATE notes SET content=NULL,revision=revision+1 WHERE path=?').run(path);
      this.db.sql.prepare('INSERT INTO notes VALUES (?,?,1)').run(newPath, old.content);
      return { path, revision: expectedRevision + 1, newPath, newRevision: 1 };
    }));
  }
}
