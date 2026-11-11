import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, readdir, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { configureAudio, fileStorage } from '../../../src/server/audio/configure-audio';
import { pcmToWav } from '@context/shared/infrastructure/gemini-tts-client';
import { DEFAULT_VOICE_INSTRUCTIONS } from '../../../src/server/audio/voice-instructions';

const MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x44]);
const dirs: string[] = [];
async function tempDir() { const d = await mkdtemp(join(tmpdir(), 'recall-audio-')); dirs.push(d); return d; }
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

const openAiFetch = () => vi.fn().mockImplementation(async () => new Response(MP3, { status: 200 }));
const geminiFetch = () => vi.fn().mockImplementation(async () => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: pcmToWav(Buffer.from([1, 0])).toString('base64') } }] } }],
}), { status: 200 }));

describe('configureAudio', () => {
  it('is disabled without a TTS key', () => {
    expect(configureAudio({})).toBeUndefined();
  });

  it('rejects an invalid TTS or LLM provider', () => {
    expect(() => configureAudio({ RECALL_TTS_KEY: 'k', RECALL_TTS_PROVIDER: 'polly' })).toThrow('Invalid RECALL_TTS_PROVIDER');
    expect(() => configureAudio({ RECALL_TTS_KEY: 'k', RECALL_LLM_PROVIDER: 'x' })).toThrow('Invalid RECALL_LLM_PROVIDER');
  });

  it('defaults to OpenAI with the legacy request and the legacy cache file name', async () => {
    const dir = await tempDir();
    const fetchImpl = openAiFetch();
    const audio = configureAudio({ RECALL_TTS_KEY: 'sk-x', RECALL_AUDIO_DIR: dir }, { fetchImpl })!;
    expect(audio.rewriter).toBeNull();

    await audio.cache.getOrGenerate('item', 'q', 'hola');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/audio/speech');
    expect(JSON.parse(init.body)).toEqual({
      model: 'gpt-4o-mini-tts', input: 'hola', voice: 'alloy', response_format: 'mp3', instructions: DEFAULT_VOICE_INSTRUCTIONS,
    });
    // Pinned from the pre-provider code: sha256("alloy:gpt-4o-mini-tts:<default instructions>:hola").slice(0, 12).
    expect(await readdir(dir)).toEqual(['item-q-0a1f1dc293c4.mp3']);
  });

  it('serves an existing OpenAI cache file without calling the provider', async () => {
    const dir = await tempDir();
    await fileStorage().write(join(dir, 'item-q-0a1f1dc293c4.mp3'), Buffer.from('old'));
    const fetchImpl = openAiFetch();
    const audio = configureAudio({ RECALL_TTS_KEY: 'sk-x', RECALL_TTS_PROVIDER: 'openai', RECALL_AUDIO_DIR: dir }, { fetchImpl })!;
    expect((await audio.cache.getOrGenerate('item', 'q', 'hola')).toString()).toBe('old');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('selects Gemini with Kore, gemini-3.8-flash-tts, no style and a provider-scoped cache key', async () => {
    const dir = await tempDir();
    const fetchImpl = geminiFetch();
    const convert = vi.fn().mockResolvedValue(MP3);
    const audio = configureAudio({ RECALL_TTS_KEY: 'g-key', RECALL_TTS_PROVIDER: 'gemini', RECALL_AUDIO_DIR: dir }, { fetchImpl, convert })!;

    expect((await audio.cache.getOrGenerate('item', 'q', 'hola')).equals(MP3)).toBe(true);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent');
    const body = JSON.parse(init.body);
    expect(body.generationConfig.speechConfig.voiceConfig.voice).toBe('Kore');
    expect(body.contents[0].parts[0]).toEqual({ text: 'hola' });
    const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
    expect(await readdir(dir)).toEqual([`item-q-${h('gemini:Kore:gemini-3.8-flash-tts::hola')}.mp3`]);
    expect(h('gemini:Kore:gemini-3.8-flash-tts::hola')).not.toBe(h('Kore:gemini-3.8-flash-tts::hola'));
  });

  it('sends RECALL_TTS_INSTRUCTIONS to Gemini as style when set', async () => {
    const fetchImpl = geminiFetch();
    const audio = configureAudio({ RECALL_TTS_KEY: 'g', RECALL_TTS_PROVIDER: 'gemini', RECALL_AUDIO_DIR: await tempDir(), RECALL_TTS_INSTRUCTIONS: 'calm' },
      { fetchImpl, convert: vi.fn().mockResolvedValue(MP3) })!;
    await audio.cache.getOrGenerate('item', 'a', 'hola');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).contents[0].parts[0].speech_metadata).toEqual({ style: 'calm' });
  });

  it('checks ffmpeg at startup for Gemini and fails fast', () => {
    const assertFfmpeg = vi.fn();
    configureAudio({ RECALL_TTS_KEY: 'g', RECALL_TTS_PROVIDER: 'gemini', RECALL_FFMPEG: '/opt/x/ffmpeg' }, { assertFfmpeg });
    expect(assertFfmpeg).toHaveBeenCalledWith('/opt/x/ffmpeg');
    expect(() => configureAudio({ RECALL_TTS_KEY: 'g', RECALL_TTS_PROVIDER: 'gemini', RECALL_FFMPEG: '/nonexistent/ffmpeg' }))
      .toThrow(/ffmpeg is required.*RECALL_FFMPEG/);
    const openAiCheck = vi.fn();
    configureAudio({ RECALL_TTS_KEY: 'k' }, { assertFfmpeg: openAiCheck });
    expect(openAiCheck).not.toHaveBeenCalled();
  });
});

describe('fileStorage', () => {
  it('writes atomically and leaves no temp files', async () => {
    const dir = await tempDir();
    const path = join(dir, 'a', 'b.mp3');
    await fileStorage().write(path, Buffer.from('one'));
    await fileStorage().write(path, Buffer.from('two'));
    expect((await readFile(path)).toString()).toBe('two');
    expect(await readdir(join(dir, 'a'))).toEqual(['b.mp3']);
    expect(await fileStorage().read(join(dir, 'missing'))).toBeNull();
  });

  it('cleans up the temp file and leaves no target when the write fails', async () => {
    const dir = await tempDir();
    const path = join(dir, 'taken');
    await mkdir(path); // rename onto a directory fails
    await expect(fileStorage().write(path, Buffer.from('x'))).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['taken']);
    expect(await readdir(path)).toEqual([]);
  });
});
