import { Notice, PluginSettingTab, App, Setting } from 'obsidian';
import type RecallPlugin from './plugin';
import { generateToken } from './voice-api/auth';

export * from './recall-settings';
import { DEFAULT_VOICE_INSTRUCTIONS, LlmProvider } from './recall-settings';

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

    const backend = this.plugin.settings.backend ??= { enabled: false, url: '', token: '', syncNotes: false };
    new Setting(containerEl).setName('Use standalone backend')
      .setDesc('Migrate existing data first. Reload Recall after changing connection settings. Remote mode never writes local scheduling data.')
      .addToggle(toggle => toggle.setValue(backend.enabled).onChange(async value => {
        backend.enabled = value;
        await this.plugin.saveData(this.plugin.settings);
        new Notice('Reload Recall to change storage mode.');
        this.display();
      }));
    new Setting(containerEl).setName('Backend URL').setDesc('HTTPS endpoint, or HTTP over a trusted private network. No /api/v1 suffix.')
      .addText(text => text.setPlaceholder('https://recall.example.com').setValue(backend.url).onChange(async value => {
        backend.url = value.trim(); await this.plugin.saveData(this.plugin.settings);
      }));
    new Setting(containerEl).setName('Backend token').setDesc('Keep this secret. Stored with plugin settings; protect your vault backups.')
      .addText(text => { text.inputEl.type = 'password'; text.setValue(backend.token).onChange(async value => {
        backend.token = value.trim(); await this.plugin.saveData(this.plugin.settings);
      }); });
    new Setting(containerEl).setName('Publish Markdown notes').setDesc('Opt in on your editing device. Uploads Markdown to your backend; never downloads or overwrites local notes. Use “Publish notes to backend” for the first upload or reconnection.')
      .addToggle(toggle => toggle.setValue(backend.syncNotes).onChange(async value => {
        backend.syncNotes = value; await this.plugin.saveData(this.plugin.settings);
        new Notice('Reload Recall to apply publishing settings.');
      }));
    if (backend.enabled || this.plugin.isRemoteMode()) {
      containerEl.createEl('p', { text: 'Scheduling limits, tags and audio are configured on the server. Existing local data is retained for migration only.' });
      return;
    }

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

    // Data management
    containerEl.createEl('h2', { text: 'Data' });

    new Setting(containerEl)
      .setName('Rebuild index')
      .setDesc(
        'Re-scan all vault notes and rebuild the card index from scratch. ' +
        'Use on a new device after Sync, or if cards are missing. ' +
        'Preserves existing review progress.',
      )
      .addButton((btn) => {
        btn
          .setButtonText('Rebuild')
          .onClick(async () => {
            btn.setButtonText('Rebuilding...');
            btn.setDisabled(true);
            try {
              await this.plugin.rebuildIndex();
              btn.setButtonText('✓ Done');
            } catch (err) {
              btn.setButtonText('✗ Error');
              console.error('Rebuild error:', err);
            }
            setTimeout(() => {
              btn.setButtonText('Rebuild');
              btn.setDisabled(false);
            }, 3000);
          });
      });

    // Migration section
    containerEl.createEl('h2', { text: 'Migration' });

    new Setting(containerEl)
      .setName('Import from Spaced Repetition')
      .setDesc(
        'Import scheduling data from the Spaced Repetition plugin (<!--SR:!date,interval,ease--> comments). ' +
        'Only updates cards that haven\'t been reviewed in Recall yet. Safe to run multiple times.',
      )
      .addButton((btn) => {
        btn
          .setButtonText('Import')
          .setCta()
          .onClick(async () => {
            btn.setButtonText('Importing...');
            btn.setDisabled(true);
            try {
              const count = await this.plugin.importFromSR();
              btn.setButtonText(`✓ Imported ${count} cards`);
              setTimeout(() => {
                btn.setButtonText('Import');
                btn.setDisabled(false);
              }, 3000);
            } catch (err) {
              btn.setButtonText('✗ Error');
              console.error('SR import error:', err);
              setTimeout(() => {
                btn.setButtonText('Import');
                btn.setDisabled(false);
              }, 3000);
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
          .addOption('deepseek', 'DeepSeek')
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
        deepseek: 'DeepSeek',
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

      const defaultModelHint: Record<string, string> = {
        openai: 'gpt-4o-mini',
        anthropic: 'claude-haiku-4-5-20250414',
        gemini: 'gemini-2.0-flash',
        deepseek: 'deepseek-chat',
      };
      new Setting(containerEl)
        .setName('Model (optional)')
        .setDesc(
          'Override the default model. Examples: ' +
          `${defaultModelHint[this.plugin.settings.llmProvider] ?? ''}, deepseek-v4, ` +
          'gpt-4.1-mini, claude-sonnet-4-6. Leave empty for the provider default.',
        )
        .addText((text) => {
          text.inputEl.style.width = '300px';
          text
            .setPlaceholder(defaultModelHint[this.plugin.settings.llmProvider] ?? '')
            .setValue(this.plugin.settings.llmModel)
            .onChange(async (value) => {
              this.plugin.settings.llmModel = value.trim();
              await this.plugin.saveSettings();
            });
        });
    }

    // Voice API section — local HTTP server for the car / mobile client
    containerEl.createEl('h2', { text: 'Voice API (car / mobile)' });

    const intro = containerEl.createEl('p', {
      cls: 'setting-item-description',
    });
    intro.appendText(
      'Expose a local HTTP API so a mobile companion app can run review ' +
      'sessions by voice (TTS reads cards, STT captures ratings). Reach ' +
      'this PC from your phone over ',
    );
    intro.createEl('a', {
      text: 'Tailscale',
      href: 'https://tailscale.com/',
    });
    intro.appendText(' (recommended) for end-to-end encrypted access without exposing your machine to the public internet.');

    new Setting(containerEl)
      .setName('Enable voice API server')
      .setDesc('Start the HTTP server when Obsidian launches. Disabled by default.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.voiceApi.enabled)
          .onChange(async (value) => {
            this.plugin.settings.voiceApi.enabled = value;
            // Auto-generate a token the first time the API is enabled
            if (value && !this.plugin.settings.voiceApi.token) {
              this.plugin.settings.voiceApi.token = generateToken();
            }
            await this.plugin.saveSettings();
            this.display();
          });
      });

    new Setting(containerEl)
      .setName('Port')
      .setDesc('TCP port for the HTTP server. Restart the server after changing.')
      .addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.style.width = '90px';
        text
          .setValue(String(this.plugin.settings.voiceApi.port))
          .onChange(async (value) => {
            const n = parseInt(value);
            if (!isNaN(n) && n > 0 && n < 65536) {
              this.plugin.settings.voiceApi.port = n;
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(containerEl)
      .setName('Bind address')
      .setDesc(
        '0.0.0.0 listens on all interfaces (needed so Tailscale can reach the server). ' +
        '127.0.0.1 restricts to localhost only.',
      )
      .addText((text) => {
        text.inputEl.style.width = '160px';
        text
          .setValue(this.plugin.settings.voiceApi.bindAddress)
          .onChange(async (value) => {
            this.plugin.settings.voiceApi.bindAddress = value.trim() || '0.0.0.0';
            await this.plugin.saveSettings();
          });
      });

    // Token row — show / regenerate / copy
    new Setting(containerEl)
      .setName('API token')
      .setDesc(
        'Bearer token required by the mobile client. Treat it like a password. ' +
        'Regenerate to revoke any previously authorized device.',
      )
      .addText((text) => {
        text.inputEl.type = 'text';
        text.inputEl.readOnly = true;
        text.inputEl.style.width = '320px';
        text.inputEl.style.fontFamily = 'monospace';
        text.setValue(this.plugin.settings.voiceApi.token || '(not generated)');
      })
      .addButton((btn) => {
        btn
          .setButtonText('Copy')
          .onClick(async () => {
            const t = this.plugin.settings.voiceApi.token;
            if (!t) {
              new Notice('No token to copy yet.');
              return;
            }
            await navigator.clipboard.writeText(t);
            new Notice('Token copied to clipboard.');
          });
      })
      .addButton((btn) => {
        btn
          .setButtonText('Regenerate')
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.voiceApi.token = generateToken();
            await this.plugin.saveSettings();
            this.display();
            new Notice('New token generated. Update the mobile client.');
          });
      });

    new Setting(containerEl)
      .setName('Restart server')
      .setDesc('Apply port / bind-address changes immediately.')
      .addButton((btn) => {
        btn
          .setButtonText('Restart')
          .onClick(async () => {
            try {
              await this.plugin.restartVoiceApi();
              new Notice('Voice API restarted.');
            } catch (err) {
              new Notice(`Failed: ${(err as Error).message}`);
            }
          });
      });

    // Cloud TTS section
    containerEl.createEl('h2', { text: 'Voice TTS (cloud)' });

    const ttsIntro = containerEl.createEl('p', { cls: 'setting-item-description' });
    ttsIntro.setText(
      'Generate card audio with OpenAI TTS-1 (multilingual). Audio is cached on disk per card — only the first request hits the API. Falls back to on-device TTS in the mobile app if disabled or unreachable.',
    );

    new Setting(containerEl)
      .setName('Enable cloud TTS')
      .setDesc('Serve audio via /api/v1/audio/<id>/<side>. Disabled by default.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.voiceTts.enabled)
          .onChange(async (value) => {
            this.plugin.settings.voiceTts.enabled = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('OpenAI API key')
      .setDesc('Used only for /v1/audio/speech. Stored locally in the vault.')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.inputEl.style.width = '320px';
        text
          .setPlaceholder('sk-...')
          .setValue(this.plugin.settings.voiceTts.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.voiceTts.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Voice')
      .setDesc('Pick an OpenAI voice. All work for es / en / de.')
      .addDropdown((dd) => {
        const voices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'ash', 'ballad', 'coral', 'sage', 'verse'];
        for (const v of voices) dd.addOption(v, v);
        dd.setValue(this.plugin.settings.voiceTts.voice || 'alloy');
        dd.onChange(async (value) => {
          this.plugin.settings.voiceTts.voice = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('TTS model')
      .setDesc(
        'gpt-4o-mini-tts handles multilingual natively (recommended; lets you turn off LLM preprocessing). ' +
        'tts-1 is faster and cheaper but mono-language per utterance. tts-1-hd is higher quality but slower.',
      )
      .addDropdown((dd) => {
        const models = ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'];
        for (const m of models) dd.addOption(m, m);
        dd.setValue(this.plugin.settings.voiceTts.model || 'gpt-4o-mini-tts');
        dd.onChange(async (value) => {
          this.plugin.settings.voiceTts.model = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Voice instructions (gpt-4o-mini-tts only)')
      .setDesc(
        'Free-text steering for the voice. Ignored by tts-1/tts-1-hd. ' +
        'Tip: write in ENGLISH — OpenAI models follow English steering far better than Spanish.',
      )
      .addTextArea((text) => {
        text.inputEl.rows = 6;
        text.inputEl.style.width = '100%';
        text
          .setValue(this.plugin.settings.voiceTts.instructions)
          .onChange(async (value) => {
            this.plugin.settings.voiceTts.instructions = value;
            await this.plugin.saveSettings();
          });
      })
      .addExtraButton((btn) => {
        btn
          .setIcon('reset')
          .setTooltip('Reset to recommended English instructions')
          .onClick(async () => {
            this.plugin.settings.voiceTts.instructions = DEFAULT_VOICE_INSTRUCTIONS;
            await this.plugin.saveSettings();
            this.display();
            new Notice('Instructions reset to default.');
          });
      });

    new Setting(containerEl)
      .setName('LLM preprocessing for multilingual cards')
      .setDesc(
        'Run each card through the configured LLM (uses your existing LLM API key) before TTS — adds Spanish cues like "La palabra inglesa: …" so TTS-1 reads each language with its native accent. Cached per card.',
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.voiceTts.llmPreprocess)
          .onChange(async (value) => {
            this.plugin.settings.voiceTts.llmPreprocess = value;
            await this.plugin.saveSettings();
          });
      });

    // Container for the rewrite preview (filled by Test LLM button below)
    const llmTestOutput = containerEl.createDiv({ cls: 'recall-llm-test-output' });
    llmTestOutput.style.padding = '8px 12px';
    llmTestOutput.style.margin = '0 0 12px 0';
    llmTestOutput.style.background = 'var(--background-secondary)';
    llmTestOutput.style.borderRadius = '6px';
    llmTestOutput.style.fontSize = '0.9em';
    llmTestOutput.style.fontFamily = 'var(--font-monospace)';
    llmTestOutput.style.whiteSpace = 'pre-wrap';
    llmTestOutput.style.display = 'none';

    new Setting(containerEl)
      .setName('Test LLM')
      .setDesc(
        'Send a sample multilingual card to the LLM with the rewriter prompt and show the result.',
      )
      .addButton((btn) => {
        btn
          .setButtonText('Test')
          .onClick(async () => {
            btn.setButtonText('Testing…');
            btn.setDisabled(true);
            llmTestOutput.style.display = 'block';
            llmTestOutput.setText('Working…');
            try {
              const result = await this.plugin.testLlm();
              if (result.ok) {
                btn.setButtonText('✓ OK');
                llmTestOutput.setText(
                  `Original:\n  ${result.original}\n\nRewritten:\n  ${result.rewritten}`,
                );
              } else {
                btn.setButtonText('✗ Failed');
                llmTestOutput.setText(`Error: ${result.error}`);
              }
            } finally {
              setTimeout(() => {
                btn.setButtonText('Test');
                btn.setDisabled(false);
              }, 3000);
            }
          });
      });

    new Setting(containerEl)
      .setName('Test TTS')
      .setDesc('Synthesize a short sentence and report success or the error.')
      .addButton((btn) => {
        btn
          .setButtonText('Test')
          .onClick(async () => {
            btn.setButtonText('Testing…');
            btn.setDisabled(true);
            try {
              const result = await this.plugin.testTts();
              btn.setButtonText(result === null ? '✓ OK' : '✗ Failed');
              if (result !== null) new Notice(`TTS: ${result}`);
            } finally {
              setTimeout(() => {
                btn.setButtonText('Test');
                btn.setDisabled(false);
              }, 3000);
            }
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
