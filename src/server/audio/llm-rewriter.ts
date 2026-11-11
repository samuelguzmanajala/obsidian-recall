import { createHash } from 'crypto';
import { LlmClient } from '@context/shared/domain/llm-client';

export interface TextFileStorage {
  read(path: string): Promise<string | null>;
  write(path: string, data: string): Promise<void>;
}

export const REWRITER_SYSTEM_PROMPT = `You prepare flashcard text to be read aloud by a multilingual text-to-speech engine that recognises each language by itself. The text may mix Spanish, English and German. The listener is a Spanish speaker.

Your only job is light cleanup so the text sounds natural when read aloud. The output must contain the same words, in the same languages, in the same order.

Rules:
1. Never translate. Every word stays in the language it is written in: a Spanish gloss stays Spanish, an English term stays English, a German term stays German.
2. Never drop, add, summarise or explain. Keep every word, every number and every ordinal (1.º, 2.º, 3.ª…), example sentence, name and acronym.
3. Never announce or label a language: no "En inglés:", "La palabra inglesa:", "En alemán:", "en inglés" or similar, before or after anything.
   Only exception: a word that stands alone, with nothing else in the text, and is spelled the same in two of these languages; then add a short tag after it, e.g. "neglect, en inglés".
   A foreign term next to its Spanish translation or gloss is NOT ambiguous: never tag it.
   Technical terms, product names and acronyms inside a Spanish sentence are read inline, with no notice.
4. A fill-in-the-blank gap ("___", "..." or "…") stays as "…". Never spell it out.
5. Remove leftover Markdown and symbols that are not meant to be spoken: asterisks, backticks, brackets, quotes around terms, list markers, arrows, LaTeX. An arrow becomes a comma.
6. Alternatives separated by "/" become a comma-separated list.
7. A parenthesised gloss or aside becomes a comma-separated aside: drop the parentheses and keep the words inside exactly as written.
8. Keep sentence-ending punctuation (".", "?", "!", "…").
9. Output ONLY the result on a single line: no commentary, no labels, no quotes around it. If nothing needs cleaning, return the input unchanged.

Examples:

Input: enfermera profesional (usado en Suiza)
Output: enfermera profesional, usado en Suiza

Input: Pflegefachfrau
Output: Pflegefachfrau

Input: "Separation of concerns": separar aspectos que nos preocupan al desarrollar funcionalidad.
Output: Separation of concerns: separar aspectos que nos preocupan al desarrollar funcionalidad.

Input: Característica (feature). Otros nombres según disciplina: variable predictora, atributo, entrada
Output: Característica, feature. Otros nombres según disciplina: variable predictora, atributo, entrada

Input: 1.º localización. 2.º variabilidad. 3.º asimetría (skewness). 4.º curtosis (kurtosis)
Output: 1.º localización. 2.º variabilidad. 3.º asimetría, skewness. 4.º curtosis, kurtosis

Input: sorprendido / desconcertado (I was … by his rude comment)
Output: sorprendido, desconcertado, I was … by his rude comment

Input: Wir sitzen um den Tisch. um + Akkusativ → der → den
Output: Wir sitzen um den Tisch. um + Akkusativ, der, den

Input: Ich wohne in...
Output: Ich wohne in…

Input: der Hund (el perro)
Output: der Hund, el perro

Input: Debe enviar los eventos fallidos a una **dead letter queue**.
Output: Debe enviar los eventos fallidos a una dead letter queue.`;

export class LlmRewriter {
  /** In-memory dedup of concurrent requests for the same input. */
  private readonly inFlight = new Map<string, Promise<string>>();
  /** Part of every cache key: changing the instruction invalidates stored rewrites. */
  private readonly promptVersion: string;

  constructor(
    private readonly llm: LlmClient,
    private readonly storage: TextFileStorage,
    private readonly cacheDir: string = 'recall-data/voice-rewrite-cache',
    private readonly systemPrompt: string = REWRITER_SYSTEM_PROMPT,
  ) {
    this.promptVersion = createHash('sha256').update(systemPrompt).digest('hex').slice(0, 12);
  }

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
          { role: 'system', content: this.systemPrompt },
          { role: 'user', content: input },
        ]);
        const out = response.content.replace(/\s+/g, ' ').trim();
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
    return createHash('sha256').update(`${this.promptVersion}:${text}`).digest('hex').slice(0, 12);
  }
}
