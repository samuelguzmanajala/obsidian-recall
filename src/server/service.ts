import { createHash } from 'node:crypto';
import { Container } from './container';
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from './server-settings';
import { StudyItemId } from '../context/study/domain/study-item-id';
import { Rating } from '../context/study/domain/rating';
import { Direction } from '../context/study/domain/direction';
import { markdownToVoice } from './audio/markdown-to-voice';
import { RecallDatabase, payloadHash } from './database';

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
export function dueLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10000) throw new ApiError(400, 'limit must be 1–10000');
  return value as number;
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
  readonly settings: ServerSettings;
  /** Built once: its adapters hold no state and only work inside `db.transaction()`. */
  readonly container: Container;
  constructor(readonly db: RecallDatabase, settings: Partial<ServerSettings> = {}) {
    this.settings = { ...structuredClone(DEFAULT_SERVER_SETTINGS), ...settings };
    this.container = new Container(db, this.settings.flashcardTags);
  }
  query<T>(work: (c: Container) => Promise<T>): Promise<T> {
    return this.db.transaction(() => work(this.container));
  }
  async reindexIfTagsChanged(): Promise<void> {
    await this.db.transaction(async () => {
      const tags = JSON.stringify(this.settings.flashcardTags);
      if (((this.db.stmt("SELECT value FROM meta WHERE key='index-tags'").get()?.value as string | undefined) ?? 'null') === tags) return;
      const c = this.container;
      const affected = new Set((await c.studyItemRepository.findAll()).map(i => i.id.value));
      const notes = this.db.sql.prepare('SELECT path,content FROM notes WHERE content IS NOT NULL').all();
      for (const note of notes) await c.indexer.syncFile(note.path as string, note.content as string);
      for (const item of await c.studyItemRepository.findAll()) affected.add(item.id.value);
      if (notes.length) for (const id of affected) this.bumpRevision(id);
      this.db.stmt("INSERT INTO meta VALUES ('index-tags', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(tags);
    });
  }
  private async allowance(c: Container) {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const day = start.getTime();
    const stored = this.db.stmt('SELECT introduced, reviewed FROM daily_budgets WHERE day_start=?').get(day);
    const introduced = stored ? Number(stored.introduced) : await c.reviewLog.countFirstReviewedSince(start);
    const reviewed = stored ? Number(stored.reviewed) : await c.reviewLog.countSince(start) - introduced;
    return {
      day, introduced, reviewed,
      newLeft: this.settings.dailyNewLimit === 0 ? Infinity : Math.max(0, this.settings.dailyNewLimit - introduced),
      reviewLeft: this.settings.dailyReviewLimit === 0 ? Infinity : Math.max(0, this.settings.dailyReviewLimit - reviewed),
    };
  }
  async due(deckId?: string, limit = 50) {
    return this.query(async c => {
      const { newLeft, reviewLeft } = await this.allowance(c);
      let newCount = 0, reviewCount = 0;
      const now = new Date();
      const due = await c.getDueStudyItems.execute(now, deckId);
      const items = due.filter(item => item.reps === 0 ? newCount++ < newLeft : reviewCount++ < reviewLeft);
      if (this.settings.shuffleReviews) {
        for (let i = items.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [items[i], items[j]] = [items[j], items[i]];
        }
      }
      const result = [];
      for (const item of items.slice(0, limit)) result.push({
        ...c.getDueStudyItems.withPreview(item, now), revision: this.itemRevision(item.studyItemId),
        source: await c.indexer.findFileByConceptId(item.conceptId),
        voiceQuestion: markdownToVoice(item.direction === Direction.AtoB ? item.sideA : item.sideB),
        voiceAnswer: markdownToVoice(item.direction === Direction.AtoB ? item.sideB : item.sideA),
      });
      return { items: result };
    });
  }
  /** Survives removal of the study item, so a recreated item never reuses an old revision. */
  private itemRevision(id: string): number {
    return Number(this.db.stmt('SELECT revision FROM item_revisions WHERE study_item_id=?').get(id)?.revision ?? 0);
  }
  private bumpRevision(id: string): number {
    const next = this.itemRevision(id) + 1;
    this.db.stmt('INSERT INTO item_revisions VALUES (?,?) ON CONFLICT(study_item_id) DO UPDATE SET revision=excluded.revision').run(id, next);
    return next;
  }
  private async once(id: string, payload: unknown, apply: () => Promise<unknown>) {
    const hash = payloadHash(JSON.stringify(payload));
    const existing = this.db.sql.prepare('SELECT payload_hash,result FROM operations WHERE id=?').get(id);
    if (existing) {
      if (existing.payload_hash !== hash) throw new ApiError(409, 'operationId was already used for a different command');
      return JSON.parse(existing.result as string);
    }
    const result = await apply();
    this.db.sql.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(id, hash, JSON.stringify(result), Date.now());
    return result;
  }
  /**
   * Expiry is safe: every command carries `expectedRevision`, so a retry arriving after its receipt
   * expired is re-evaluated and rejected with 409 (or acknowledged as identical content for notes)
   * instead of being applied twice. `days` = 0 keeps receipts forever.
   */
  expireReceipts(days: number, now = Date.now()): Promise<number> {
    return this.db.transaction(async () => days === 0 ? 0
      : Number(this.db.sql.prepare('DELETE FROM operations WHERE created_at < ?').run(now - days * 86_400_000).changes));
  }
  async review(body: unknown) {
    const cmd = record(body);
    const operationId = string(cmd.operationId, 'operationId', 128);
    const studyItemId = string(cmd.studyItemId, 'studyItemId', 256);
    const expectedRevision = revision(cmd.expectedRevision);
    if (!Object.values(Rating).includes(cmd.rating as Rating)) throw new ApiError(400, 'Invalid rating');
    const rating = cmd.rating as Rating;
    return this.db.transaction(() => this.once(operationId, { type: 'review', studyItemId, rating, expectedRevision }, async () => {
      const c = this.container;
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
      this.db.stmt('INSERT INTO daily_budgets VALUES (?,?,?) ON CONFLICT(day_start) DO UPDATE SET introduced=excluded.introduced, reviewed=excluded.reviewed')
        .run(allowance.day, allowance.introduced + (item.memoryState.reps === 0 ? 1 : 0), allowance.reviewed + (item.memoryState.reps === 0 ? 0 : 1));
      return { studyItemId, revision: this.bumpRevision(studyItemId), operationId };
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
      const c = this.container;
      const affected = new Set((await c.sources.get(path))?.studyItemIds ?? []);
      if (content === null) await c.indexer.removeFile(path);
      else await c.indexer.syncFile(path, content);
      // Invalidate queued reviews when note contents change, including remove/recreate of stable IDs.
      for (const id of (await c.sources.get(path))?.studyItemIds ?? []) affected.add(id);
      for (const id of affected) this.bumpRevision(id);
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
      await this.container.indexer.renameFile(path, newPath);
      this.db.sql.prepare('UPDATE notes SET content=NULL,revision=revision+1 WHERE path=?').run(path);
      this.db.sql.prepare('INSERT INTO notes VALUES (?,?,1)').run(newPath, old.content);
      return { path, revision: expectedRevision + 1, newPath, newRevision: 1 };
    }));
  }
}
