import { LlmClient, LlmMessage, LlmResponse } from '../domain/llm-client';

interface ProviderConfig {
  baseUrl: string;
  defaultModel: string;
  /** Transform messages/headers if the provider isn't fully OpenAI-compatible */
  authHeader: (apiKey: string) => Record<string, string>;
  extractContent: (json: any) => string;
  extractTokens?: (json: any) => number | undefined;
}

const PROVIDERS: Record<string, ProviderConfig> = {
  openai: {
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o-mini',
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    extractContent: (json) => json.choices?.[0]?.message?.content ?? '',
    extractTokens: (json) => json.usage?.total_tokens,
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-haiku-4-5-20250414',
    authHeader: (key) => ({
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    }),
    extractContent: (json) => {
      const block = json.content?.find((b: any) => b.type === 'text');
      return block?.text ?? '';
    },
    extractTokens: (json) =>
      (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0),
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    defaultModel: 'gemini-2.0-flash',
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    extractContent: (json) => json.choices?.[0]?.message?.content ?? '',
    extractTokens: (json) => json.usage?.total_tokens,
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/chat/completions',
    defaultModel: 'deepseek-chat',
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    extractContent: (json) => json.choices?.[0]?.message?.content ?? '',
    extractTokens: (json) => json.usage?.total_tokens,
  },
};

export class HttpLlmClient implements LlmClient {
  constructor(
    private readonly getProvider: () => string,
    private readonly getApiKey: () => string,
    private readonly getModel: () => string = () => '',
    private readonly timeoutMs = 30_000,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  isConfigured(): boolean {
    const provider = this.getProvider();
    const key = this.getApiKey();
    return provider !== 'none' && key.length > 0 && provider in PROVIDERS;
  }

  async complete(messages: LlmMessage[]): Promise<LlmResponse> {
    const provider = this.getProvider();
    const apiKey = this.getApiKey();

    if (!this.isConfigured()) {
      throw new Error('LLM not configured. Set provider and API key in Recall settings.');
    }

    const config = PROVIDERS[provider];
    const model = this.getModel().trim() || config.defaultModel;

    const body = provider === 'anthropic'
      ? this.buildAnthropicBody(messages, model)
      : this.buildOpenAiBody(messages, model);

    let json: any;
    try {
      const response = await (this.fetchImpl ?? fetch)(config.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...config.authHeader(apiKey),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`LLM API error (${response.status}): ${text}`);
      }

      json = await response.json();
    } catch (error) {
      if ((error as Error)?.name === 'TimeoutError') throw new Error(`LLM request timed out after ${this.timeoutMs / 1000} s`);
      throw error;
    }

    return {
      content: config.extractContent(json),
      tokensUsed: config.extractTokens?.(json),
    };
  }

  private buildOpenAiBody(messages: LlmMessage[], model: string): any {
    return {
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      temperature: 0.7,
    };
  }

  private buildAnthropicBody(messages: LlmMessage[], model: string): any {
    const system = messages.find(m => m.role === 'system')?.content;
    const nonSystem = messages.filter(m => m.role !== 'system');

    return {
      model,
      max_tokens: 2048,
      ...(system ? { system } : {}),
      messages: nonSystem.map(m => ({ role: m.role, content: m.content })),
    };
  }
}
