import { Notice, PluginSettingTab, App, Setting } from 'obsidian';
import type RecallPlugin from './plugin';

export * from './plugin-settings';

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

    const backend = this.plugin.settings.backend;
    new Setting(containerEl).setName('Backend URL').setDesc('HTTPS endpoint, or HTTP over a trusted private network. No /api/v1 suffix. Reload Recall after changing connection settings.')
      .addText(text => text.setPlaceholder('https://recall.example.com').setValue(backend.url).onChange(async value => {
        backend.url = value.trim(); await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName('Backend token').setDesc('Keep this secret. Stored with plugin settings; protect your vault backups.')
      .addText(text => { text.inputEl.type = 'password'; text.setValue(backend.token).onChange(async value => {
        backend.token = value.trim(); await this.plugin.saveSettings();
      }); });
    new Setting(containerEl).setName('Publish Markdown notes').setDesc('Opt in on your editing device. Uploads Markdown to your backend; never downloads or overwrites local notes. Use “Publish notes to backend” for the first upload or reconnection.')
      .addToggle(toggle => toggle.setValue(backend.syncNotes).onChange(async value => {
        backend.syncNotes = value; await this.plugin.saveSettings();
        new Notice('Reload Recall to apply publishing settings.');
      }));
    containerEl.createEl('p', { text: 'Scheduling limits, tags and audio are configured on the server (see docs/backend.md). Existing local data is retained for migration only.' });
  }
}
