import { createHash } from 'crypto';
import { LlmClient } from '@context/shared/domain/llm-client';

export interface TextFileStorage {
  read(path: string): Promise<string | null>;
  write(path: string, data: string): Promise<void>;
}

export const REWRITER_SYSTEM_PROMPT = `You are preparing flashcard text for a multilingual text-to-speech (TTS) engine. The text may mix Spanish, English, and German.

Your job: rewrite the input so the TTS reads each language with the correct accent. The user is a native Spanish speaker — frame transitions in Spanish.

Detection step (do this internally, never output it):
1. Identify the dominant base language (usually Spanish).
2. For every foreign segment, detect if it's English, German, or another language.
3. Wrap each foreign segment in DOUBLE QUOTES so the TTS treats it as a verbatim token in that language.

Rules:
- Keep meaning and order intact. Do not add, remove, or translate.
- Before each language switch, insert a brief Spanish framing cue:
  - English: "La palabra inglesa:" / "La frase en inglés:" / "En inglés:"
  - German:  "La palabra alemana:" / "La frase en alemán:" / "En alemán:"
  - Back to Spanish (only if a switch happened mid-card): "En español:"
- ALWAYS surround foreign segments with double quotes — even single words. This is critical: the quotes are how the TTS knows to switch accent.
- If the input has a fill-in-the-blank gap (rendered as "…" or sometimes still as "___"), keep it as "…" — that produces a natural pause. NEVER spell it out as "espacio en blanco" or similar.
- Strip any leftover markdown (asterisks, backticks, brackets, parentheses around the gloss).
- Preserve sentence-ending punctuation (".", "?", "!").
- Output ONLY the rewritten text on a single line. No commentary, no labels, no surrounding quotes around the whole thing.

Examples:

Input: neglect (No … tu salud)
Output: La palabra inglesa: "neglect". La frase en español: "No … tu salud".

Input: der Hund (el perro)
Output: La palabra alemana: "der Hund". En español: "el perro".

Input: acknowledge (Él … su error)
Output: La palabra inglesa: "acknowledge". En español: "Él … su error".

Input: descuidar
Output: descuidar.

Input: I binge-watched the whole series in one weekend (maratonear de tirón)
Output: La frase en inglés: "I binge-watched the whole series in one weekend". En español: "maratonear de tirón".

Input: aufwachen — despertarse
Output: La palabra alemana: "aufwachen". En español: "despertarse".`;

export class LlmRewriter {
  /** In-memory dedup of concurrent requests for the same input. */
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(
    private readonly llm: LlmClient,
    private readonly storage: TextFileStorage,
    private readonly cacheDir: string = 'recall-data/voice-rewrite-cache',
  ) {}

  /**
   * Rewrite [input] for multilingual TTS. Returns the rewritten string,
   * or [input] unchanged if the LLM is not configured or fails.
   * Pure server-side — caches result on disk per-input-hash.
   */
  async rewrite(input: string): Promise<string> {
    if (!input.trim()) return input;
    if (!this.llm.isConfigured()) return input;

    const hash = this.hash(input);
    const path = `${this.cacheDir}/${hash}.txt`;

    const cached = await this.storage.read(path);
    if (cached) return cached;

    const existing = this.inFlight.get(path);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const response = await this.llm.complete([
          { role: 'system', content: REWRITER_SYSTEM_PROMPT },
          { role: 'user', content: input },
        ]);
        const out = response.content.trim();
        if (!out) return input;
        await this.storage.write(path, out);
        return out;
      } catch (err) {
        console.error('[Recall API] LLM rewrite failed, using raw text:', err);
        return input;
      }
    })();

    this.inFlight.set(path, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(path);
    }
  }

  private hash(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 12);
  }
}
