import { PluginSettingTab, App, Setting } from 'obsidian';
import type RecallPlugin from './plugin';

export type LlmProvider = 'none' | 'openai' | 'anthropic' | 'gemini';

export interface RecallSettings {
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
  /** LLM provider for card generation. */
  llmProvider: LlmProvider;
  /** API key for the selected LLM provider. */
  llmApiKey: string;
}

export const DEFAULT_SETTINGS: RecallSettings = {
  flashcardTags: [],
  shuffleReviews: true,
  dailyNewLimit: 20,
  dailyReviewLimit: 0,
  leechThreshold: 8,
  llmProvider: 'none',
  llmApiKey: '',
};

export class RecallSettingTab extends PluginSettingTab {
  private plugin: RecallPlugin;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(app: App, plugin: RecallPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Recall Settings' });

    // Flashcard tags
    new Setting(containerEl)
      .setName('Flashcard tags')
      .setDesc(
        'Only notes with these tags will be indexed for flashcards. ' +
        'Subtags are included automatically (e.g. #German also matches #German/vocabulary). ' +
        'Separate multiple tags with spaces or newlines. Leave empty to index all notes.',
      )
      .addTextArea((text) => {
        text
          .setPlaceholder('#memorizar #German #dev')
          .setValue(this.plugin.settings.flashcardTags.map(t => `#${t}`).join(' '))
          .onChange((value) => {
            // Debounce: wait 1.5s after last keystroke before saving + re-syncing
            if (this.saveTimeout) clearTimeout(this.saveTimeout);
            this.saveTimeout = setTimeout(async () => {
              this.plugin.settings.flashcardTags = this.parseTags(value);
              await this.plugin.saveSettings();
            }, 1500);
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 30;
      });

    // Shuffle reviews
    new Setting(containerEl)
      .setName('Shuffle review order')
      .setDesc('Randomize the order of cards during review. Disable to review in file order.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.shuffleReviews)
          .onChange(async (value) => {
            this.plugin.settings.shuffleReviews = value;
            await this.plugin.saveSettings();
          });
      });

    // Daily new card limit
    new Setting(containerEl)
      .setName('Daily new cards limit')
      .setDesc('Maximum number of new cards introduced per day. Set to 0 for unlimited.')
      .addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.style.width = '60px';
        text
          .setValue(String(this.plugin.settings.dailyNewLimit))
          .onChange(async (value) => {
            const n = parseInt(value);
            if (!isNaN(n) && n >= 0) {
              this.plugin.settings.dailyNewLimit = n;
              await this.plugin.saveSettings();
            }
          });
      });

    // Daily review limit
    new Setting(containerEl)
      .setName('Daily review limit')
      .setDesc('Maximum number of reviews per day. Set to 0 for unlimited.')
      .addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.style.width = '60px';
        text
          .setValue(String(this.plugin.settings.dailyReviewLimit))
          .onChange(async (value) => {
            const n = parseInt(value);
            if (!isNaN(n) && n >= 0) {
              this.plugin.settings.dailyReviewLimit = n;
              await this.plugin.saveSettings();
            }
          });
      });

    // Leech threshold
    new Setting(containerEl)
      .setName('Leech threshold')
      .setDesc('Cards with this many lapses (Again presses) are flagged as leeches. Set to 0 to disable.')
      .addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.style.width = '60px';
        text
          .setValue(String(this.plugin.settings.leechThreshold))
          .onChange(async (value) => {
            const n = parseInt(value);
            if (!isNaN(n) && n >= 0) {
              this.plugin.settings.leechThreshold = n;
              await this.plugin.saveSettings();
            }
          });
      });

    // LLM section
    containerEl.createEl('h2', { text: 'AI Integration' });

    // Provider selector
    new Setting(containerEl)
      .setName('LLM provider')
      .setDesc('Select the AI provider for flashcard generation and hints.')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('none', 'None')
          .addOption('openai', 'OpenAI (GPT)')
          .addOption('anthropic', 'Anthropic (Claude)')
          .addOption('gemini', 'Google (Gemini)')
          .setValue(this.plugin.settings.llmProvider)
          .onChange(async (value) => {
            this.plugin.settings.llmProvider = value as LlmProvider;
            await this.plugin.saveSettings();
            // Re-render to show/hide API key field
            this.display();
          });
      });

    // API key — only show when a provider is selected
    if (this.plugin.settings.llmProvider !== 'none') {
      const providerNames: Record<string, string> = {
        openai: 'OpenAI',
        anthropic: 'Anthropic',
        gemini: 'Google AI',
      };
      new Setting(containerEl)
        .setName('API key')
        .setDesc(
          `Your ${providerNames[this.plugin.settings.llmProvider]} API key. ` +
          'Stored locally in your vault — never sent anywhere except the provider\'s API.',
        )
        .addText((text) => {
          text.inputEl.type = 'password';
          text.inputEl.style.width = '300px';
          text
            .setPlaceholder('sk-...')
            .setValue(this.plugin.settings.llmApiKey)
            .onChange(async (value) => {
              this.plugin.settings.llmApiKey = value.trim();
              await this.plugin.saveSettings();
            });
        });
    }
  }

  /**
   * Parse raw input like "#dev #English\n#German #historia" into clean tags.
   * Strips # prefix, trims whitespace, deduplicates.
   */
  private parseTags(raw: string): string[] {
    const tags = raw
      .split(/[\s,]+/)
      .map(t => t.trim())
      .filter(t => t.length > 0)
      .map(t => (t.startsWith('#') ? t.slice(1) : t))
      .filter(t => t.length > 0);

    return [...new Set(tags)];
  }
}
