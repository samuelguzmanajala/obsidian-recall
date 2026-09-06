import type { ServerResponse } from 'http';
import type { RouteContext } from './types';
import { sendJson } from './types';
import { StudyItemId } from '@context/study/domain/study-item-id';
import { Direction } from '@context/study/domain/direction';
import { markdownToVoice } from '../markdown-to-voice';
import { preprocessForTts } from '../preprocess-text';
import type { TtsCache } from '../tts-cache';
import type { LlmRewriter } from '../llm-rewriter';

export type AudioSide = 'question' | 'answer';

export interface AudioRouteDeps {
  cache: TtsCache | null;
  rewriter: LlmRewriter | null;
  isTtsConfigured: () => boolean;
}

export async function handleAudio(
  ctx: RouteContext,
  studyItemId: string,
  side: AudioSide,
  deps: AudioRouteDeps,
): Promise<void> {
  if (!deps.cache || !deps.isTtsConfigured()) {
    sendJson(ctx.res, 503, { error: 'cloud TTS not configured' });
    return;
  }

  const studyItem = await ctx.container.studyItemRepository.findById(new StudyItemId(studyItemId));
  if (!studyItem) {
    sendJson(ctx.res, 404, { error: 'study item not found' });
    return;
  }

  const concept = await ctx.container.conceptRepository.findById(studyItem.conceptId);
  if (!concept) {
    sendJson(ctx.res, 404, { error: 'concept not found' });
    return;
  }

  const isAtoB = studyItem.direction === Direction.AtoB;
  const sourceText = side === 'question'
    ? (isAtoB ? concept.sideA.content : concept.sideB.content)
    : (isAtoB ? concept.sideB.content : concept.sideA.content);

  const baseText = preprocessForTts(markdownToVoice(sourceText));
  if (!baseText) {
    sendJson(ctx.res, 422, { error: 'card text is empty after preprocessing' });
    return;
  }

  // LLM-rewrite the card so TTS gets clean per-language cues. Falls back
  // to the raw text if the LLM is unconfigured or fails.
  const text = deps.rewriter ? await deps.rewriter.rewrite(baseText) : baseText;

  let audio: Buffer;
  try {
    audio = await deps.cache.getOrGenerate(studyItemId, side === 'question' ? 'q' : 'a', text);
  } catch (err) {
    console.error('[Recall API] TTS generation failed:', err);
    sendJson(ctx.res, 502, { error: `tts: ${(err as Error).message}` });
    return;
  }

  sendAudio(ctx.res, audio);
}

function sendAudio(res: ServerResponse, audio: Buffer): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', audio.length.toString());
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.end(audio);
}
