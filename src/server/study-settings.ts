import type { DatabaseSync } from 'node:sqlite';
import type { ServerSettings } from './server-settings';
import { ApiError, record } from './service';

/** `meta` key of the study settings chosen from a client. Absent = the environment applies. */
export const STUDY_SETTINGS_KEY = 'study-settings';

/** Bounds of `POST /api/v1/settings` (documented in docs/backend.md). */
export const SETTINGS_BOUNDS = {
  maxTags: 200,
  maxTagLength: 200,
  maxDailyLimit: 100_000,
  maxLeechThreshold: 1_000,
} as const;

/**
 * What `meta.study-settings` holds. `settings: null` means "back to the environment values"
 * (after a reset); the revision keeps counting so a stale client is still rejected.
 */
export interface StoredStudySettings {
  revision: number;
  settings: ServerSettings | null;
}

const FIELDS = ['flashcardTags', 'dailyNewLimit', 'dailyReviewLimit', 'leechThreshold', 'shuffleReviews'] as const;

export function readStoredSettings(sql: DatabaseSync): StoredStudySettings {
  const raw = sql.prepare('SELECT value FROM meta WHERE key=?').get(STUDY_SETTINGS_KEY)?.value;
  if (typeof raw !== 'string') return { revision: 0, settings: null };
  const value = JSON.parse(raw) as StoredStudySettings;
  return { revision: value.revision, settings: value.settings && freezeSettings(value.settings) };
}

export function writeStoredSettings(sql: DatabaseSync, stored: StoredStudySettings): void {
  sql.prepare('INSERT INTO meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(STUDY_SETTINGS_KEY, JSON.stringify(stored));
}

export function freezeSettings(settings: ServerSettings): ServerSettings {
  return Object.freeze({ ...settings, flashcardTags: Object.freeze([...settings.flashcardTags]) as string[] });
}

/** Trimmed, de-duplicated and sorted (equal sets compare equal); tags are written without `#`. */
export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ApiError(400, 'flashcardTags must be an array of strings');
  if (value.length > SETTINGS_BOUNDS.maxTags) throw new ApiError(400, `flashcardTags allows at most ${SETTINGS_BOUNDS.maxTags} tags`);
  const tags = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string') throw new ApiError(400, 'flashcardTags must be an array of strings');
    const tag = raw.trim();
    if (!tag || tag.length > SETTINGS_BOUNDS.maxTagLength) throw new ApiError(400, `Each tag must have 1–${SETTINGS_BOUNDS.maxTagLength} characters`);
    if (tag.includes('#')) throw new ApiError(400, 'Write tags without #');
    if (/[\u0000-\u001f\u007f]/.test(tag)) throw new ApiError(400, 'Tags cannot contain control characters');
    tags.add(tag);
  }
  return [...tags].sort();
}

function count(value: unknown, name: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) throw new ApiError(400, `${name} must be an integer from 0 to ${max}`);
  return value as number;
}

/** Validates a subset of the five fields; unknown keys are rejected (a typo must not be silently ignored). */
export function parseSettingsPatch(value: unknown): Partial<ServerSettings> {
  const input = record(value);
  const unknown = Object.keys(input).filter(key => !(FIELDS as readonly string[]).includes(key));
  if (unknown.length) throw new ApiError(400, `Unknown settings: ${unknown.join(', ')}`);
  if (!Object.keys(input).length) throw new ApiError(400, 'settings must contain at least one field');
  const patch: Partial<ServerSettings> = {};
  if ('flashcardTags' in input) patch.flashcardTags = normalizeTags(input.flashcardTags);
  if ('dailyNewLimit' in input) patch.dailyNewLimit = count(input.dailyNewLimit, 'dailyNewLimit', SETTINGS_BOUNDS.maxDailyLimit);
  if ('dailyReviewLimit' in input) patch.dailyReviewLimit = count(input.dailyReviewLimit, 'dailyReviewLimit', SETTINGS_BOUNDS.maxDailyLimit);
  if ('leechThreshold' in input) patch.leechThreshold = count(input.leechThreshold, 'leechThreshold', SETTINGS_BOUNDS.maxLeechThreshold);
  if ('shuffleReviews' in input) {
    if (typeof input.shuffleReviews !== 'boolean') throw new ApiError(400, 'shuffleReviews must be a boolean');
    patch.shuffleReviews = input.shuffleReviews;
  }
  return patch;
}

/** Same matching rule as the indexer: a followed tag matches itself and its sub-tags. Empty = everything. */
export function tagFollowed(tag: string, filter: readonly string[]): boolean {
  return filter.length === 0 || filter.some(f => tag === f || tag.startsWith(f + '/'));
}

export function sameTagSet(a: readonly string[], b: readonly string[]): boolean {
  const x = [...new Set(a)].sort(), y = [...new Set(b)].sort();
  return x.length === y.length && x.every((tag, i) => tag === y[i]);
}
