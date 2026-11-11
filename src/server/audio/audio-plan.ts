import { createHash } from 'node:crypto';
import type { ServerAudio } from './configure-audio';
import { preprocessForTts } from './preprocess-text';
import { ApiError, type AudioSide, type RecallService } from '../service';

/**
 * Where one study item side's audio lives, for a final (post-rewrite) text. The file name
 * hashes the study item id, so identical texts of different items still get their own file.
 */
export interface AudioTarget { studyItemId: string; side: AudioSide; cacheId: string; cacheSide: 'q' | 'a'; path: string }
export interface AudioPlan extends AudioTarget { source: string; text: string }

/** Text sent to the rewriter (or to TTS when there is none). Empty: nothing to say. */
export function audioSource(voiceText: string): string {
  return preprocessForTts(voiceText);
}

export function audioTarget(audio: ServerAudio, studyItemId: string, side: AudioSide, text: string): AudioTarget {
  const cacheId = createHash('sha256').update(studyItemId).digest('hex');
  const cacheSide = side === 'question' ? 'q' : 'a';
  return { studyItemId, side, cacheId, cacheSide, path: audio.cache.pathOf(cacheId, cacheSide, text) };
}

/**
 * The single definition of "which text, in which file" for a side, used by GET /audio, the
 * background queue and pregeneration: TTS preprocessing, the optional rewrite (through its
 * cache), then the cache location. `null` when the side has nothing to say.
 */
export async function planAudio(audio: ServerAudio, studyItemId: string, side: AudioSide, voiceText: string): Promise<AudioPlan | null> {
  const source = audioSource(voiceText);
  if (!source) return null;
  const text = audio.rewriter ? await audio.rewriter.rewrite(source) : source;
  return { ...audioTarget(audio, studyItemId, side, text), source, text };
}

/** Background generation of one side (normal interactive path). Removed items are skipped. */
export async function ensureAudio(service: RecallService, audio: ServerAudio, studyItemId: string, side: AudioSide): Promise<void> {
  let voiceText: string;
  try { voiceText = await service.audioText(studyItemId, side); }
  catch (e) { if (e instanceof ApiError && e.status === 404) return; throw e; }
  const plan = await planAudio(audio, studyItemId, side, voiceText);
  if (!plan || await audio.cache.has(plan.path)) return;
  await audio.cache.getOrGenerate(plan.cacheId, plan.cacheSide, plan.text);
}
