import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { TtsCache, type BinaryFileStorage } from './tts-cache';
import { LlmRewriter } from './llm-rewriter';
import { HttpLlmClient } from '../../context/shared/infrastructure/llm-adapters';
import { OpenAiTtsClient } from '../../context/shared/infrastructure/openai-tts-client';
import { GeminiTtsClient, type GeminiTtsOptions } from '../../context/shared/infrastructure/gemini-tts-client';
import { assertFfmpegUsable, ffmpegWavToMp3, type WavToMp3 } from '../../context/shared/infrastructure/ffmpeg-audio-converter';
import { DEFAULT_VOICE_INSTRUCTIONS, type LlmProvider } from './voice-instructions';

/** `convert` is set for providers that return WAV (Gemini); pregeneration converts batch results with it. */
export interface ServerAudio { cache: TtsCache; rewriter: LlmRewriter | null; convert?: WavToMp3 }
export interface AudioDeps {
  fetchImpl?: typeof fetch;
  convert?: WavToMp3;
  assertFfmpeg?: (path: string) => void;
  /** Overrides for the Gemini client (pregeneration can wait longer than the phone). */
  gemini?: Omit<GeminiTtsOptions, 'fetchImpl'>;
}

const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];

/** A leftover OpenAI value would otherwise be sent to Gemini (and fail on every card). */
function assertGeminiSettings(env: NodeJS.ProcessEnv): void {
  const voice = env.RECALL_TTS_VOICE?.trim() ?? '';
  if (OPENAI_VOICES.includes(voice.toLowerCase())) {
    throw new Error(`RECALL_TTS_VOICE=${voice} is an OpenAI voice but RECALL_TTS_PROVIDER=gemini; use a Gemini voice (e.g. Kore) or remove it`);
  }
  const model = env.RECALL_TTS_MODEL?.trim() ?? '';
  if (/^(gpt-|tts-)/i.test(model)) {
    throw new Error(`RECALL_TTS_MODEL=${model} is an OpenAI model but RECALL_TTS_PROVIDER=gemini; use a Gemini TTS model (e.g. gemini-3.8-flash-tts) or remove it`);
  }
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
    exists: async (path: string) => {
      try { return (await stat(path)).size > 0; }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
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
  let convert: WavToMp3 | undefined;
  if (ttsProvider === 'gemini') {
    assertGeminiSettings(env);
    const ffmpeg = env.RECALL_FFMPEG || 'ffmpeg';
    if (!deps.convert) (deps.assertFfmpeg ?? assertFfmpegUsable)(ffmpeg);
    convert = deps.convert ?? ffmpegWavToMp3(ffmpeg);
    // DEFAULT_VOICE_INSTRUCTIONS is written for OpenAI: Gemini gets a style only when set explicitly.
    cache = new TtsCache(storage, new GeminiTtsClient(getKey, convert, { ...deps.gemini, fetchImpl: deps.fetchImpl }), root,
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
  return { cache, rewriter, convert };
}
