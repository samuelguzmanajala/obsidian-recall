/**
 * TTS prices in USD per 1M tokens, for estimates and spend caps only (the provider bills).
 * Gemini: https://ai.google.dev/gemini-api/docs/pricing#gemini-3.8-flash-tts (paid tier; checked
 * 2026-11-12). Google doubles them on 2027-01-01. Audio output is 25 tokens per second.
 * OpenAI (no batch here): $0.60 / $12 per 1M tokens, published as "~$0.015 per minute";
 * 20.83 tokens/s reproduces that estimate. Not verified against an invoice.
 */
export interface TokenPrice { input: number; output: number }
export interface ModelPrice { from: string; standard: TokenPrice; batch: TokenPrice | null }
export interface ModelPricing { audioTokensPerSecond: number; periods: ModelPrice[] }

export const TTS_PRICES: Record<string, ModelPricing> = {
  'gemini-3.8-flash-tts': { audioTokensPerSecond: 25, periods: [
    { from: '2026-01-01', standard: { input: 0.50, output: 9.00 }, batch: { input: 0.25, output: 4.50 } },
    { from: '2027-01-01', standard: { input: 1.00, output: 18.00 }, batch: { input: 0.50, output: 9.00 } },
  ] },
  'gpt-4o-mini-tts': { audioTokensPerSecond: 20.83, periods: [
    { from: '2026-01-01', standard: { input: 0.60, output: 12.00 }, batch: null },
  ] },
};

/** The price in force on `date` (UTC day), or undefined when the model is not in the table. */
export function priceOn(model: string, date = new Date()): (ModelPrice & { audioTokensPerSecond: number }) | undefined {
  const pricing = TTS_PRICES[model];
  if (!pricing) return undefined;
  const day = date.toISOString().slice(0, 10);
  const period = [...pricing.periods].reverse().find(p => p.from <= day) ?? pricing.periods[0];
  return { ...period, audioTokensPerSecond: pricing.audioTokensPerSecond };
}

/** The next scheduled price after `date`, if any (shown by the dry run). */
export function nextPrice(model: string, date = new Date()): ModelPrice | undefined {
  const day = date.toISOString().slice(0, 10);
  return TTS_PRICES[model]?.periods.find(p => p.from > day);
}

export function costUsd(price: TokenPrice, inputTokens: number, outputTokens: number): number {
  return (inputTokens * price.input + outputTokens * price.output) / 1e6;
}

/**
 * Deliberately high estimates (measured on 11 gemini-3.8-flash-tts clips: 7–16 characters per
 * second plus a short floor, ~4.4 characters per input token), so a spend cap errs on the safe side.
 */
export function estimateSeconds(chars: number): number { return 1 + chars / 10; }
export function estimateInputTokens(chars: number): number { return Math.ceil(chars / 3); }
