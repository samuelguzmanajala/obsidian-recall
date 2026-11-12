import { createHash } from 'node:crypto';
import { Container } from './container';
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from './server-settings';
import { StudyItemId } from '../context/study/domain/study-item-id';
import { Rating } from '../context/study/domain/rating';
import { Direction } from '../context/study/domain/direction';
import type { Concept } from '../context/concept/domain/concept';
import { markdownToVoice } from './audio/markdown-to-voice';
import { RecallDatabase, payloadHash } from './database';
import type { DeckTreeNode } from '../context/deck/application/get-deck-tree';
import { FrontmatterParser } from '../context/concept/infrastructure/frontmatter-parser';
import type { ParsedCard } from '../context/concept/infrastructure/markdown-parser';
import { Directionality } from '../context/concept/domain/directionality';
import {
  freezeSettings, parseSettingsPatch, readStoredSettings, sameTagSet, tagFollowed, writeStoredSettings, type StoredStudySettings,
} from './study-settings';

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
export type AudioSide = 'question' | 'answer';
function voiceSide(concept: Concept, direction: Direction, side: AudioSide): string {
  const a = (side === 'question') === (direction === Direction.AtoB);
  return markdownToVoice(a ? concept.sideA.content : concept.sideB.content);
}
function notePath(value: unknown): string {
  const path = string(value, 'path');
  if (!path.endsWith('.md') || path.startsWith('/') || path.includes('\\') || path.split('/').some(p => p === '..' || p === '.' || !p)) throw new ApiError(400, 'Expected a vault-relative Markdown path');
  return path;
}

class DryRunRollback { result?: unknown & Record<string, unknown>; }
/** Decks that hold at least one card, counting parents of non-empty decks (empty decks stay in the tree). */
function countDecks(nodes: DeckTreeNode[]): number {
  return nodes.reduce((n, node) => n + (node.totalItems > 0 ? 1 + countDecks(node.children) : 0), 0);
}
function studyItemCount(cards: ParsedCard[]): number {
  return cards.reduce((n, card) => n + (card.directionality === Directionality.Bidirectional ? 2 : 1), 0);
}

/** Uses the existing domain through transactional ports; no Obsidian runtime or vault filesystem. */
export class RecallService {
  /** Values from the environment (`main.ts`): they apply while no settings are stored. */
  readonly environmentSettings: ServerSettings;
  /** Mirror of `meta.study-settings`, replaced only after the transaction that wrote it commits. */
  private stored: StoredStudySettings;
  /** Tag filter of a settings change being applied (or dry-run) inside its own transaction. */
  private pendingTags: readonly string[] | null = null;
  /** Parsed tags and card count of each published note, by revision (GET /tags). */
  private readonly noteTags = new Map<string, { revision: number; tags: string[]; cards: number }>();
  /** Built once: its adapters hold no state and only work inside `db.transaction()`. */
  readonly container: Container;
  constructor(readonly db: RecallDatabase, settings: Partial<ServerSettings> = {}) {
    this.environmentSettings = freezeSettings({ ...structuredClone(DEFAULT_SERVER_SETTINGS), ...settings });
    this.stored = readStoredSettings(db.sql);
    // Read on every sync: a settings change applies to the next note without a restart.
    this.container = new Container(db, () => this.pendingTags ?? this.settings.flashcardTags);
  }
  /** Current (committed) study settings: the stored ones if any, otherwise the environment's. Frozen. */
  get settings(): ServerSettings {
    return this.stored.settings ?? this.environmentSettings;
  }
  query<T>(work: (c: Container) => Promise<T>): Promise<T> {
    return this.db.transaction(() => work(this.container));
  }
  async reindexIfTagsChanged(): Promise<void> {
    await this.db.transaction(async () => {
      const tags = JSON.stringify(this.settings.flashcardTags);
      if (((this.db.stmt("SELECT value FROM meta WHERE key='index-tags'").get()?.value as string | undefined) ?? 'null') === tags) return;
      await this.reindexAll(tags);
    });
  }
  /**
   * Re-syncs every published note with the current tag filter (inside a transaction). History is
   * untouched: removed items keep their reviews, and a recreated item replays them. Returns the
   * study item ids before and after, and how many notes were re-synced.
   */
  private async reindexAll(indexTags: string) {
    const c = this.container;
    const before = new Set((await c.studyItemRepository.findAll()).map(i => i.id.value));
    const notes = this.db.sql.prepare('SELECT path,content FROM notes WHERE content IS NOT NULL').all();
    for (const note of notes) await c.indexer.syncFile(note.path as string, note.content as string);
    const after = new Set((await c.studyItemRepository.findAll()).map(i => i.id.value));
    if (notes.length) for (const id of new Set([...before, ...after])) this.bumpRevision(id);
    this.db.stmt("INSERT INTO meta VALUES ('index-tags', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(indexTags);
    return { before, after, notes: notes.length };
  }
  /** `GET /api/v1/settings`. */
  readSettings() {
    return this.db.transaction(async () => {
      const stored = readStoredSettings(this.db.sql);
      return { settings: stored.settings ?? this.environmentSettings, source: stored.settings ? 'stored' : 'environment', revision: stored.revision };
    });
  }
  /**
   * `POST /api/v1/settings`. Applies a subset of the study settings (or `reset: true`: back to the
   * environment values), re-indexing every published note in the same transaction when the tag
   * list changes. `dryRun` computes the same answer and rolls everything back (no receipt, no
   * revision). `onCardsAdded` receives the study items the change created, after the commit.
   */
  async updateSettings(body: unknown, onCardsAdded?: (studyItemIds: string[]) => void) {
    const cmd = record(body);
    const operationId = string(cmd.operationId, 'operationId', 128);
    const expectedRevision = revision(cmd.expectedRevision);
    if (cmd.dryRun !== undefined && typeof cmd.dryRun !== 'boolean') throw new ApiError(400, 'dryRun must be a boolean');
    if (cmd.reset !== undefined && typeof cmd.reset !== 'boolean') throw new ApiError(400, 'reset must be a boolean');
    const reset = cmd.reset === true;
    if (reset && cmd.settings !== undefined) throw new ApiError(400, 'Send either settings or reset, not both');
    const patch = reset ? null : parseSettingsPatch(cmd.settings);
    const apply = async () => {
      const current = readStoredSettings(this.db.sql);
      if (current.revision !== expectedRevision) throw new ApiError(409, 'Settings changed on another device; reload them');
      const previous = current.settings ?? this.environmentSettings;
      const next = patch ? freezeSettings({ ...previous, ...patch }) : null;
      const effective = next ?? this.environmentSettings;
      const c = this.container;
      const items = async () => new Set((await c.studyItemRepository.findAll()).map(i => i.id.value));
      const decks = async () => countDecks(await c.getDeckTree.execute());
      const decksBefore = await decks();
      let before: Set<string>, after: Set<string>, notes = 0;
      if (sameTagSet(previous.flashcardTags, effective.flashcardTags)) {
        before = after = await items();
      } else {
        this.pendingTags = effective.flashcardTags;
        try { ({ before, after, notes } = await this.reindexAll(JSON.stringify(effective.flashcardTags))); }
        finally { this.pendingTags = null; }
      }
      const added = [...after].filter(id => !before.has(id));
      const stored: StoredStudySettings = { revision: current.revision + 1, settings: next };
      writeStoredSettings(this.db.sql, stored);
      this.db.onCommit(() => { this.stored = stored; });
      return {
        result: {
          settings: effective, source: next ? 'stored' : 'environment', revision: stored.revision,
          impact: {
            notes, cardsBefore: before.size, cardsAfter: after.size, cardsAdded: added.length,
            cardsRemoved: [...before].filter(id => !after.has(id)).length, decksBefore, decksAfter: await decks(),
          },
        },
        added,
      };
    };
    if (cmd.dryRun === true) {
      // Same work in a transaction that is always rolled back: nothing is written, not even a receipt.
      const rollback = new DryRunRollback();
      await this.db.transaction(async () => { rollback.result = (await apply()).result; throw rollback; })
        .catch(error => { if (error !== rollback) throw error; });
      return { ...rollback.result!, dryRun: true };
    }
    let added: string[] = [];
    const payload = { type: 'settings', expectedRevision, ...(reset ? { reset } : { settings: patch }) };
    const result = await this.db.transaction(() => this.once(operationId, payload, async () => {
      const applied = await apply();
      added = applied.added;
      return applied.result;
    }));
    if (added.length && onCardsAdded) {
      try { onCardsAdded(added); } catch (error) { console.error('[Recall backend] settings change listener failed:', error); }
    }
    return result;
  }
  /**
   * `GET /api/v1/tags`: every tag in the published notes' frontmatter, with its ancestors (a
   * followed tag covers its sub-tags), and the tags in the current filter even when no note has
   * them. `notes`/`cards` count what following that tag covers (the tag or any sub-tag), whatever
   * the current filter; `cards` are study items as the parser finds them in each note (a `:::`
   * card counts 2), counted per note. `selected` = in the filter; `followed` = studied under the
   * current filter. `untagged`: notes without tags, studied (deck "Untagged") only when the filter
   * is empty. Parsed notes are cached by revision, so only changed notes are parsed again.
   */
  tags() {
    return this.db.transaction(async () => {
      const filter = this.settings.flashcardTags;
      const rows = this.db.stmt('SELECT path,revision FROM notes WHERE content IS NOT NULL').all();
      const live = new Set<string>();
      const coverage = new Map<string, { notes: number; cards: number }>();
      const untagged = { notes: 0, cards: 0 };
      for (const row of rows) {
        const path = row.path as string, rev = Number(row.revision);
        live.add(path);
        let parsed = this.noteTags.get(path);
        if (!parsed || parsed.revision !== rev) {
          const content = this.db.stmt('SELECT content FROM notes WHERE path=?').get(path)!.content as string;
          parsed = { revision: rev, tags: this.frontmatter.extractTags(content), cards: studyItemCount(this.container.parser.parse(content, path)) };
          this.noteTags.set(path, parsed);
        }
        if (!parsed.tags.length) { untagged.notes++; untagged.cards += parsed.cards; continue; }
        const covering = new Set<string>();
        for (const tag of parsed.tags) {
          const parts = tag.split('/');
          for (let i = 1; i <= parts.length; i++) covering.add(parts.slice(0, i).join('/'));
        }
        for (const tag of covering) {
          const entry = coverage.get(tag) ?? { notes: 0, cards: 0 };
          entry.notes++; entry.cards += parsed.cards;
          coverage.set(tag, entry);
        }
      }
      for (const path of this.noteTags.keys()) if (!live.has(path)) this.noteTags.delete(path);
      for (const tag of filter) if (!coverage.has(tag)) coverage.set(tag, { notes: 0, cards: 0 });
      return {
        tags: [...coverage].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([tag, counts]) => ({
          tag, ...counts, selected: filter.includes(tag), followed: tagFollowed(tag, filter),
        })),
        untagged: { ...untagged, followed: filter.length === 0 },
      };
    });
  }
  private readonly frontmatter = new FrontmatterParser();
  /** Today's daily-limit counters (read-only; `Infinity` = unlimited). Call inside a transaction. */
  async allowance(c: Container) {
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
  /** `onCommitted` receives the note's current study item ids after a change has been committed. */
  async note(body: unknown, onCommitted?: (studyItemIds: string[]) => void) {
    const cmd = record(body);
    const operationId = string(cmd.operationId, 'operationId', 128);
    const path = notePath(cmd.path);
    const expectedRevision = revision(cmd.expectedRevision);
    const content = cmd.content;
    if (content !== null && (typeof content !== 'string' || Buffer.byteLength(content) > 2_000_000)) throw new ApiError(400, 'Invalid note content');
    let changed: string[] = [];
    const result = await this.db.transaction(() => this.once(operationId, { type: 'note', path, content, expectedRevision }, async () => {
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
      changed = [...(await c.sources.get(path))?.studyItemIds ?? []];
      for (const id of changed) affected.add(id);
      for (const id of affected) this.bumpRevision(id);
      this.db.sql.prepare('INSERT INTO notes VALUES (?,?,?) ON CONFLICT(path) DO UPDATE SET content=excluded.content,revision=excluded.revision')
        .run(path, content as string | null, current + 1);
      return { path, revision: current + 1 };
    }));
    if (changed.length && onCommitted) {
      try { onCommitted(changed); } catch (error) { console.error('[Recall backend] note change listener failed:', error); }
    }
    return result;
  }
  notes() {
    return this.db.transaction(async () => ({ notes: this.db.sql.prepare('SELECT path,content,revision FROM notes ORDER BY path').all().map(row => ({
      path: row.path, revision: row.revision, deleted: row.content === null,
      hash: row.content === null ? null : createHash('sha256').update(row.content as string).digest('hex'),
    })) }));
  }
  audioText(studyItemId: string, side: AudioSide) {
    return this.query(async c => {
      const item = await c.studyItemRepository.findById(new StudyItemId(studyItemId));
      if (!item) throw new ApiError(404, 'Study item not found');
      const concept = await c.conceptRepository.findById(item.conceptId);
      if (!concept) throw new ApiError(404, 'Concept not found');
      return voiceSide(concept, item.direction, side);
    });
  }
  /** Voice text of every side of every study item, read in one short transaction (pregeneration). */
  audioSides() {
    return this.query(async c => {
      const concepts = new Map((await c.conceptRepository.findAll()).map(concept => [concept.id.value, concept]));
      const sides: { studyItemId: string; side: AudioSide; voiceText: string }[] = [];
      let items = 0;
      for (const item of await c.studyItemRepository.findAll()) {
        const concept = concepts.get(item.conceptId.value);
        if (!concept) continue;
        items++;
        for (const side of ['question', 'answer'] as const) sides.push({ studyItemId: item.id.value, side, voiceText: voiceSide(concept, item.direction, side) });
      }
      return { concepts: concepts.size, items, sides };
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
