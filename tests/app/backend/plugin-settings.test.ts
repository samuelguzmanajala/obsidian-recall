import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, isBackendConfigured, loadPluginSettings, normalizeInboxFolder } from '../../../src/app/backend/plugin-settings';

describe('loadPluginSettings', () => {
  it('returns defaults for a fresh install', () => {
    expect(loadPluginSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(loadPluginSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(loadPluginSettings('garbage')).toEqual(DEFAULT_SETTINGS);
  });

  it('reads a legacy local-mode data.json and preserves every key it no longer uses', () => {
    const legacy = {
      flashcardTags: ['German'], shuffleReviews: false, dailyNewLimit: 5, dailyReviewLimit: 0, leechThreshold: 8,
      expandedDeckIds: ['deck-1'],
      llmProvider: 'openai', llmApiKey: 'sk-secret', llmModel: '',
      voiceApi: { enabled: true, port: 27124, token: 'voice-token', bindAddress: '0.0.0.0' },
      voiceTts: { enabled: true, apiKey: 'tts-secret', voice: 'alloy', model: 'gpt-4o-mini-tts', instructions: '', llmPreprocess: false },
    };
    const settings = loadPluginSettings(structuredClone(legacy));
    expect(settings).toEqual({ ...legacy, backend: { url: '', token: '', syncNotes: false }, proposalInboxFolder: 'Recall inbox' });
    // What `saveData(settings)` writes back still contains the user's old keys.
    expect(JSON.parse(JSON.stringify(settings))).toMatchObject(legacy);
  });

  it('accepts and keeps a legacy backend.enabled flag without requiring it', () => {
    const on = loadPluginSettings({ backend: { enabled: true, url: 'https://recall.example', token: 't', syncNotes: true } });
    expect(on.backend).toEqual({ enabled: true, url: 'https://recall.example', token: 't', syncNotes: true });
    expect(isBackendConfigured(on)).toBe(true);
    // The old toggle no longer gates anything: a disabled flag with a URL and token is still configured.
    const off = loadPluginSettings({ backend: { enabled: false, url: 'https://recall.example', token: 't', syncNotes: false } });
    expect(off.backend.enabled).toBe(false);
    expect(isBackendConfigured(off)).toBe(true);
    expect(isBackendConfigured(loadPluginSettings({ backend: { url: 'https://recall.example' } }))).toBe(false);
  });

  it('repairs malformed values instead of failing to load', () => {
    const settings = loadPluginSettings({ backend: { url: 42, token: null, syncNotes: 'yes' }, expandedDeckIds: ['a', 3, null, 'b'] });
    expect(settings.backend).toEqual({ url: '', token: '', syncNotes: false });
    expect(settings.expandedDeckIds).toEqual(['a', 'b']);
    expect(loadPluginSettings({ expandedDeckIds: 'a' }).expandedDeckIds).toEqual([]);
  });

  it('does not share state with DEFAULT_SETTINGS', () => {
    const settings = loadPluginSettings({});
    settings.expandedDeckIds.push('x');
    settings.backend.url = 'changed';
    expect(DEFAULT_SETTINGS).toEqual({ backend: { url: '', token: '', syncNotes: false }, expandedDeckIds: [], proposalInboxFolder: 'Recall inbox' });
  });
});

describe('card proposals inbox folder setting', () => {
  it('defaults to "Recall inbox" and keeps a stored folder', () => {
    expect(loadPluginSettings({}).proposalInboxFolder).toBe('Recall inbox');
    expect(loadPluginSettings({ proposalInboxFolder: 'Languages/Inbox' }).proposalInboxFolder).toBe('Languages/Inbox');
  });

  it('normalizes slashes and spaces', () => {
    expect(normalizeInboxFolder('  /Languages//Inbox/ ')).toBe('Languages/Inbox');
    expect(normalizeInboxFolder('Languages\\Inbox')).toBe('Languages/Inbox');
    expect(normalizeInboxFolder('./Inbox')).toBe('Inbox');
  });

  it('falls back to the default for unusable folders instead of writing outside the vault or into hidden ones', () => {
    for (const bad of [42, null, '', '  ', '/', '../Outside', 'a/../b', '.obsidian/plugins', 'x/node_modules', 'a:b']) {
      expect(normalizeInboxFolder(bad)).toBe('Recall inbox');
    }
  });
});
