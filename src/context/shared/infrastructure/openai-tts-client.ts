import { TtsClient, TtsRequest } from '../domain/tts-client';

const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';
const DEFAULT_MODEL = 'tts-1';

export class OpenAiTtsClient implements TtsClient {
  constructor(
    private readonly getApiKey: () => string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  isConfigured(): boolean {
    return this.getApiKey().trim().length > 0;
  }

  async synthesize(req: TtsRequest): Promise<Buffer> {
    const key = this.getApiKey().trim();
    if (!key) {
      throw new Error('OpenAI TTS API key not configured.');
    }

    const body: Record<string, unknown> = {
      model: req.model ?? DEFAULT_MODEL,
      input: req.text,
      voice: req.voice,
      response_format: req.format,
    };
    if (req.instructions && req.instructions.trim()) {
      body.instructions = req.instructions.trim();
    }

    const res = await this.fetchImpl(OPENAI_TTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI TTS error (${res.status}): ${text.slice(0, 300)}`);
    }

    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  }
}
