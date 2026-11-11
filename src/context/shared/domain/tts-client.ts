/**
 * Port for cloud TTS providers. Domain defines the contract,
 * infrastructure provides adapters (OpenAI, Gemini, Google Cloud, etc.).
 */
export interface TtsRequest {
  text: string;
  voice: string;
  /** TTS model — provider-specific. */
  model?: string;
  /** Optional steering instructions (OpenAI gpt-4o-mini-tts: `instructions`; Gemini: `speech_metadata.style`). */
  instructions?: string;
  format: 'mp3' | 'opus' | 'aac' | 'wav';
}

/**
 * The provider's per-day quota is exhausted: retrying today is pointless.
 * Callers (e.g. batch generation) recognise it by class or by `code`.
 */
export class TtsDailyQuotaError extends Error {
  readonly code = 'TTS_DAILY_QUOTA';
  constructor(message: string) { super(message); this.name = 'TtsDailyQuotaError'; }
}

export interface TtsClient {
  /**
   * Synthesize [req.text] into audio bytes in [req.format].
   * Throws on any HTTP / parse / network failure.
   */
  synthesize(req: TtsRequest): Promise<Buffer>;

  /** True if API key (and any other required config) is present. */
  isConfigured(): boolean;
}
