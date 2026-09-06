import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { TtsCache } from '../app/backend/voice-api/tts-cache';
import { LlmRewriter } from '../app/backend/voice-api/llm-rewriter';
import { HttpLlmClient } from '../context/shared/infrastructure/llm-adapters';
import { OpenAiTtsClient } from '../context/shared/infrastructure/openai-tts-client';
import { DEFAULT_VOICE_INSTRUCTIONS, type LlmProvider } from '../app/backend/recall-settings';

export interface ServerAudio { cache: TtsCache; rewriter: LlmRewriter | null }
/** Reuses existing speech adapters; provider credentials stay only on the server. */
export function configureAudio(env = process.env): ServerAudio | undefined {
  if (!env.RECALL_TTS_KEY) return undefined;
  const root = resolve(env.RECALL_AUDIO_DIR ?? './data/audio');
  const storage = {
    read: async (path: string) => {
      try { return await readFile(path); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    },
    write: async (path: string, data: Buffer) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, data, { mode: 0o600 }); },
  };
  const provider = env.RECALL_LLM_PROVIDER ?? 'none';
  if (!['none', 'openai', 'anthropic', 'gemini', 'deepseek'].includes(provider)) throw new Error('Invalid RECALL_LLM_PROVIDER');
  const cache = new TtsCache(storage, new OpenAiTtsClient(() => env.RECALL_TTS_KEY ?? ''), root,
    env.RECALL_TTS_VOICE ?? 'alloy', env.RECALL_TTS_MODEL ?? 'gpt-4o-mini-tts', env.RECALL_TTS_INSTRUCTIONS ?? DEFAULT_VOICE_INSTRUCTIONS);
  const llm = new HttpLlmClient(() => provider as LlmProvider, () => env.RECALL_LLM_KEY ?? '', () => env.RECALL_LLM_MODEL ?? '');
  const rewriter = env.RECALL_LLM_KEY ? new LlmRewriter(llm, {
    read: async path => (await storage.read(path))?.toString('utf8') ?? null,
    write: async (path, data) => storage.write(path, Buffer.from(data)),
  }, resolve(root, 'rewrites', provider, env.RECALL_LLM_MODEL?.replace(/[^a-zA-Z0-9_-]/g, '_') || 'default')) : null;
  return { cache, rewriter };
}
