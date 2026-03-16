import { PluginSettingTab, App, Setting } from 'obsidian';
import type RecallPlugin from './plugin';

export interface RecallSettings {
  /** Tags to track for flashcards. Empty = track ALL notes with cards. */
  flashcardTags: string[];
  /** Shuffle review order. Default true. */
  shuffleReviews: boolean;
}

export const DEFAULT_SETTINGS: RecallSettings = {
  flashcardTags: [],
  shuffleReviews: true,
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
