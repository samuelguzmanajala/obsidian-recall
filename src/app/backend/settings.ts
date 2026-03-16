import { PluginSettingTab, App, Setting } from 'obsidian';
import type RecallPlugin from './plugin';

export interface RecallSettings {
  /** Tags to track for flashcards. Empty = track ALL notes with cards. */
  flashcardTags: string[];
}

export const DEFAULT_SETTINGS: RecallSettings = {
  flashcardTags: [],
};

export class RecallSettingTab extends PluginSettingTab {
  private plugin: RecallPlugin;

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
          .onChange(async (value) => {
            this.plugin.settings.flashcardTags = this.parseTags(value);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 30;
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
