import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LlmRewriter, REWRITER_SYSTEM_PROMPT, type TextFileStorage } from '../../../src/server/audio/llm-rewriter';
import type { LlmClient } from '@context/shared/domain/llm-client';

class InMemoryTextStorage implements TextFileStorage {
  files = new Map<string, string>();
  async read(path: string) { return this.files.get(path) ?? null; }
  async write(path: string, data: string) { this.files.set(path, data); }
}

function makeLlm(overrides: Partial<LlmClient> = {}): LlmClient & { complete: ReturnType<typeof vi.fn> } {
  return {
    isConfigured: () => true,
    complete: vi.fn().mockResolvedValue({ content: 'rewritten output' }),
    ...overrides,
  } as LlmClient & { complete: ReturnType<typeof vi.fn> };
}

describe('LlmRewriter', () => {
  let storage: InMemoryTextStorage;
  let llm: LlmClient & { complete: ReturnType<typeof vi.fn> };
  let rewriter: LlmRewriter;

  beforeEach(() => {
    storage = new InMemoryTextStorage();
    llm = makeLlm();
    rewriter = new LlmRewriter(llm, storage);
  });

  it('returns input unchanged when LLM is not configured', async () => {
    rewriter = new LlmRewriter(makeLlm({ isConfigured: () => false }), storage);
    expect(await rewriter.rewrite('hola')).toBe('hola');
  });

  it('returns input unchanged when input is blank', async () => {
    expect(await rewriter.rewrite('')).toBe('');
    expect(await rewriter.rewrite('   ')).toBe('   ');
  });

  it('calls the LLM and persists the result on cold miss', async () => {
    const out = await rewriter.rewrite('neglect (No ___ tu salud)');
    expect(out).toBe('rewritten output');
    expect(llm.complete).toHaveBeenCalledOnce();
    expect(storage.files.size).toBe(1);
  });

  it('serves from disk on subsequent calls', async () => {
    await rewriter.rewrite('hola');
    await rewriter.rewrite('hola');
    expect(llm.complete).toHaveBeenCalledOnce();
  });

  it('different inputs produce different cache entries', async () => {
    await rewriter.rewrite('hola');
    await rewriter.rewrite('adios');
    expect(llm.complete).toHaveBeenCalledTimes(2);
    expect(storage.files.size).toBe(2);
  });

  it('falls back to raw input when the LLM throws', async () => {
    llm.complete.mockRejectedValueOnce(new Error('rate limit'));
    const out = await rewriter.rewrite('hola');
    expect(out).toBe('hola');
    expect(storage.files.size).toBe(0); // no caching on failure
  });

  it('falls back to raw input when the LLM returns empty', async () => {
    llm.complete.mockResolvedValueOnce({ content: '' });
    const out = await rewriter.rewrite('hola');
    expect(out).toBe('hola');
  });

  it('concurrent requests share a single LLM call', async () => {
    let resolveCall: (v: { content: string }) => void = () => {};
    llm.complete.mockImplementation(() =>
      new Promise<{ content: string }>((resolve) => { resolveCall = resolve; }));

    const a = rewriter.rewrite('hola');
    const b = rewriter.rewrite('hola');
    const c = rewriter.rewrite('hola');

    await new Promise((r) => setTimeout(r, 10));
    resolveCall({ content: 'shared output' });

    const [r1, r2, r3] = await Promise.all([a, b, c]);
    expect(r1).toBe('shared output');
    expect(r2).toBe('shared output');
    expect(r3).toBe('shared output');
    expect(llm.complete).toHaveBeenCalledOnce();
  });

  it('changing the instruction invalidates cached rewrites', async () => {
    await rewriter.rewrite('hola');
    const other = new LlmRewriter(llm, storage, 'recall-data/voice-rewrite-cache', 'another instruction');
    await other.rewrite('hola');
    expect(llm.complete).toHaveBeenCalledTimes(2);
    expect(storage.files.size).toBe(2);
    expect(llm.complete.mock.calls[1][0][0].content).toBe('another instruction');
  });

  it('ignores rewrites cached under the old key (hash of the input only)', async () => {
    storage.files.set('recall-data/voice-rewrite-cache/b221d9dbb083.txt', 'La palabra española: "hola".');
    expect(await rewriter.rewrite('hola')).toBe('rewritten output');
    expect(llm.complete).toHaveBeenCalledOnce();
  });

  it('flattens a multi-line answer to one line', async () => {
    llm.complete.mockResolvedValueOnce({ content: 'uno\n dos\n' });
    expect(await rewriter.rewrite('x')).toBe('uno dos');
  });

  it('instruction forbids language announcements and keeps the hardening examples', () => {
    expect(REWRITER_SYSTEM_PROMPT).toMatch(/Never announce or label a language/);
    expect(REWRITER_SYSTEM_PROMPT).toMatch(/Never translate/);
    expect(REWRITER_SYSTEM_PROMPT).toContain('Output: enfermera profesional, usado en Suiza');
    expect(REWRITER_SYSTEM_PROMPT).toContain('Output: Característica, feature.');
    expect(REWRITER_SYSTEM_PROMPT).toContain('Output: 1.º localización. 2.º variabilidad.');
    expect(REWRITER_SYSTEM_PROMPT).not.toMatch(/Output: (La palabra|La frase|En inglés|En alemán)/);
  });

  it('sends the system prompt and the user input as messages', async () => {
    await rewriter.rewrite('test input');
    const calls = llm.complete.mock.calls[0];
    const messages = calls[0];
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1]).toEqual({ role: 'user', content: 'test input' });
  });
});
