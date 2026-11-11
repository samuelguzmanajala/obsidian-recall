import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { TtsCache, type BinaryFileStorage } from './tts-cache';
import { LlmRewriter } from './llm-rewriter';
import { HttpLlmClient } from '../../context/shared/infrastructure/llm-adapters';
import { OpenAiTtsClient } from '../../context/shared/infrastructure/openai-tts-client';
import { GeminiTtsClient } from '../../context/shared/infrastructure/gemini-tts-client';
import { assertFfmpegUsable, ffmpegWavToMp3, type WavToMp3 } from '../../context/shared/infrastructure/ffmpeg-audio-converter';
import { DEFAULT_VOICE_INSTRUCTIONS, type LlmProvider } from './voice-instructions';

export interface ServerAudio { cache: TtsCache; rewriter: LlmRewriter | null }
export interface AudioDeps {
  fetchImpl?: typeof fetch;
  convert?: WavToMp3;
  assertFfmpeg?: (path: string) => void;
}

/** Disk storage whose writes are atomic: a failed or interrupted write never leaves a partial file. */
export function fileStorage(): BinaryFileStorage {
  return {
    read: async (path: string) => {
      try { return await readFile(path); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    },
    write: async (path: string, data: Buffer) => {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
      try { await writeFile(tmp, data, { mode: 0o600 }); await rename(tmp, path); }
      catch (e) { await rm(tmp, { force: true }); throw e; }
    },
  };
}

/** Reuses existing speech adapters; provider credentials stay only on the server. */
export function configureAudio(env = process.env, deps: AudioDeps = {}): ServerAudio | undefined {
  if (!env.RECALL_TTS_KEY) return undefined;
  const root = resolve(env.RECALL_AUDIO_DIR ?? './data/audio');
  const storage = fileStorage();
  const provider = env.RECALL_LLM_PROVIDER ?? 'none';
  if (!['none', 'openai', 'anthropic', 'gemini', 'deepseek'].includes(provider)) throw new Error('Invalid RECALL_LLM_PROVIDER');
  const ttsProvider = env.RECALL_TTS_PROVIDER ?? 'openai';
  if (!['openai', 'gemini'].includes(ttsProvider)) throw new Error('Invalid RECALL_TTS_PROVIDER');
  const getKey = () => env.RECALL_TTS_KEY ?? '';
  let cache: TtsCache;
  if (ttsProvider === 'gemini') {
    const ffmpeg = env.RECALL_FFMPEG || 'ffmpeg';
    if (!deps.convert) (deps.assertFfmpeg ?? assertFfmpegUsable)(ffmpeg);
    // DEFAULT_VOICE_INSTRUCTIONS is written for OpenAI: Gemini gets a style only when set explicitly.
    cache = new TtsCache(storage, new GeminiTtsClient(getKey, deps.convert ?? ffmpegWavToMp3(ffmpeg), { fetchImpl: deps.fetchImpl }), root,
      env.RECALL_TTS_VOICE ?? 'Kore', env.RECALL_TTS_MODEL ?? 'gemini-3.8-flash-tts', env.RECALL_TTS_INSTRUCTIONS ?? '', 'gemini');
  } else {
    cache = new TtsCache(storage, new OpenAiTtsClient(getKey, deps.fetchImpl), root,
      env.RECALL_TTS_VOICE ?? 'alloy', env.RECALL_TTS_MODEL ?? 'gpt-4o-mini-tts', env.RECALL_TTS_INSTRUCTIONS ?? DEFAULT_VOICE_INSTRUCTIONS);
  }
  const llm = new HttpLlmClient(() => provider as LlmProvider, () => env.RECALL_LLM_KEY ?? '', () => env.RECALL_LLM_MODEL ?? '');
  const rewriter = env.RECALL_LLM_KEY ? new LlmRewriter(llm, {
    read: async path => (await storage.read(path))?.toString('utf8') ?? null,
    write: async (path, data) => storage.write(path, Buffer.from(data)),
  }, resolve(root, 'rewrites', provider, env.RECALL_LLM_MODEL?.replace(/[^a-zA-Z0-9_-]/g, '_') || 'default')) : null;
  return { cache, rewriter };
}
