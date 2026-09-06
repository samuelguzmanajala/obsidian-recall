/**
 * Port for cloud TTS providers. Domain defines the contract,
 * infrastructure provides adapters (OpenAI, Gemini, Google Cloud, etc.).
 */
export interface TtsRequest {
  text: string;
  voice: string;
  /** TTS model — provider-specific. */
  model?: string;
  /** Optional steering instructions (e.g. accent, tone) — supported by gpt-4o-mini-tts. */
  instructions?: string;
  format: 'mp3' | 'opus' | 'aac' | 'wav';
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
