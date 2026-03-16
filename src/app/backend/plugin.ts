import { Plugin, TFile } from 'obsidian';
import { Container } from './container';
import { createObsidianFilePort } from './obsidian-storage';
import { VaultSync } from './vault-sync';

export default class RecallPlugin extends Plugin {
  container!: Container;
  vaultSync!: VaultSync;

  async onload(): Promise<void> {
    this.container = new Container({
      concepts: createObsidianFilePort(this.app, 'concepts.json'),
      studyItems: createObsidianFilePort(this.app, 'study-items.json'),
      decks: createObsidianFilePort(this.app, 'decks.json'),
      reviews: createObsidianFilePort(this.app, 'reviews.json'),
    });
    this.vaultSync = new VaultSync(this.container);

    await this.initialSync();

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          this.onFileChange(file);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          this.vaultSync.removeFile(file.path);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile && file.extension === 'md') {
          this.vaultSync.removeFile(oldPath);
          this.onFileChange(file);
        }
      }),
    );

    console.log('Recall plugin loaded');
  }

  onunload(): void {
    console.log('Recall plugin unloaded');
  }

  private async initialSync(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      const content = await this.app.vault.cachedRead(file);
      await this.vaultSync.syncFile(file.path, content);
    }
  }

  private async onFileChange(file: TFile): Promise<void> {
    const content = await this.app.vault.cachedRead(file);
    await this.vaultSync.syncFile(file.path, content);
  }
}
