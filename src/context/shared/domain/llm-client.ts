/**
 * Port for LLM interactions. Domain defines the contract,
 * infrastructure provides the adapter (OpenAI, Anthropic, Gemini, etc.)
 */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmResponse {
  content: string;
  tokensUsed?: number;
}

export interface LlmClient {
  /**
   * Send a chat completion request.
   * Throws if no API key is configured or the request fails.
   */
  complete(messages: LlmMessage[]): Promise<LlmResponse>;

  /**
   * Check if the client is configured and ready to use.
   */
  isConfigured(): boolean;
}
