export type LlmProvider = 'none' | 'openai' | 'anthropic' | 'gemini' | 'deepseek';

/**
 * Voice instructions for gpt-4o-mini-tts. Written in English because that's
 * what OpenAI's models follow most reliably for steering.
 */
export const DEFAULT_VOICE_INSTRUCTIONS = [
  'You are reading flashcard text aloud for a Spanish learner studying English and German.',
  'The text mixes Spanish (the framing language), English, and sometimes German.',
  '',
  'Strict pronunciation rules:',
  '1. Words written in English MUST be pronounced with native English pronunciation.',
  '2. Words written in Spanish MUST be pronounced with native Spanish (Castilian) pronunciation.',
  '3. Words written in German MUST be pronounced with native German pronunciation.',
  '4. Switch accents IMMEDIATELY between segments. Never use a hybrid or neutral accent.',
  '5. Words enclosed in double quotes are foreign-language tokens — pronounce them in their native language.',
  '6. Spanish framings like "La palabra inglesa:" stay in Spanish; the quoted word that follows must be in its language.',
  '',
  'Pacing: moderate and clear, suitable for someone listening while driving.',
  'Tone: warm, like a tutor who knows the student is making progress.',
].join('\n');

export interface VoiceApiSettings {
  enabled: boolean;
  port: number;
  token: string;
  bindAddress: string;
}

export interface VoiceTtsSettings {
  /** Whether the audio endpoint should attempt cloud generation. */
  enabled: boolean;
  /** OpenAI API key for /v1/audio/speech. */
  apiKey: string;
  /** OpenAI voice id (alloy, echo, fable, onyx, nova, shimmer). */
  voice: string;
  /** OpenAI TTS model — gpt-4o-mini-tts handles multilingual natively. */
  model: string;
  /** Free-text steering for gpt-4o-mini-tts (accent, tone, pace). Empty = no instructions. */
  instructions: string;
  /** Run card text through the configured LLM before TTS to handle multilingual mixing. */
  llmPreprocess: boolean;
}

export interface RecallSettings {
  /** Remote mode must be explicitly enabled after migrating existing data. */
  backend?: { enabled: boolean; url: string; token: string; syncNotes: boolean };
  /** Tags to track for flashcards. Empty = track ALL notes with cards. */
  flashcardTags: string[];
  /** Shuffle review order. Default true. */
  shuffleReviews: boolean;
  /** Max new cards per day. 0 = unlimited. */
  dailyNewLimit: number;
  /** Max reviews per day. 0 = unlimited. */
  dailyReviewLimit: number;
  /** Leech threshold — items with this many lapses are marked as leeches. */
  leechThreshold: number;
  /** Deck IDs the user has expanded in the sidebar. */
  expandedDeckIds: string[];

  /** LLM provider for card generation. */
  llmProvider: LlmProvider;
  /** API key for the selected LLM provider. */
  llmApiKey: string;
  /** Optional model override — empty falls back to the provider's default (e.g. deepseek-chat). */
  llmModel: string;

  /** Local HTTP API for the mobile/voice client (consumed via Tailscale). */
  voiceApi: VoiceApiSettings;

  /** Cloud TTS for serving multilingual audio to the voice API client. */
  voiceTts: VoiceTtsSettings;
}

export const DEFAULT_SETTINGS: RecallSettings = {
  flashcardTags: [],
  shuffleReviews: true,
  dailyNewLimit: 20,
  dailyReviewLimit: 0,
  leechThreshold: 8,
  expandedDeckIds: [],
  llmProvider: 'none',
  llmApiKey: '',
  llmModel: '',
  voiceApi: {
    enabled: false,
    port: 27124,
    token: '',
    bindAddress: '0.0.0.0',
  },
  voiceTts: {
    enabled: false,
    apiKey: '',
    voice: 'alloy',
    model: 'gpt-4o-mini-tts',
    instructions: DEFAULT_VOICE_INSTRUCTIONS,
    llmPreprocess: false,
  },
};
