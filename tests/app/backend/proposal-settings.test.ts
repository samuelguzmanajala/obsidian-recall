import { describe, expect, it, vi } from 'vitest';
vi.mock('obsidian', async () => ({
  ...await vi.importActual<object>('obsidian'),
  PluginSettingTab: class { containerEl: unknown; constructor(_app: unknown, _plugin: unknown) {} },
}));
import { RecallSettingTab } from '../../../src/app/backend/settings';
import { loadPluginSettings } from '../../../src/app/backend/plugin-settings';

class FakeEl {
  children: FakeEl[] = [];
  setting?: any;
  constructor(readonly tag: string, readonly options: { text?: string; cls?: string } = {}) {}
  empty() { this.children = []; }
  createEl(tag: string, options?: { text?: string; cls?: string }) { const el = new FakeEl(tag, options); this.children.push(el); return el; }
  createDiv(options?: { cls?: string }) { return this.createEl('div', options); }
  all(): FakeEl[] { return [this, ...this.children.flatMap(c => c.all())]; }
}

describe('settings tab: card proposals inbox folder', () => {
  it('shows the folder and saves it normalized', async () => {
    const plugin = { settings: loadPluginSettings({}), saveSettings: vi.fn(async () => {}) };
    const client = { isConfigured: () => false, getStudySettings: vi.fn(), getTags: vi.fn(), updateStudySettings: vi.fn(), notifyChanged: vi.fn() };
    const tab: any = new RecallSettingTab({} as any, plugin as any, client);
    tab.containerEl = new FakeEl('div');
    tab.display();
    const setting = (tab.containerEl as FakeEl).all().map(e => e.setting).find(s => s?.name === 'Card proposals inbox folder');
    expect(setting.desc).toMatch(/one note per deck/);
    const field = setting.components[0];
    expect(field.value).toBe('Recall inbox');
    await field.change(' /Languages//Inbox/ ');
    expect(plugin.settings.proposalInboxFolder).toBe('Languages/Inbox');
    await field.change('../outside');
    expect(plugin.settings.proposalInboxFolder).toBe('Recall inbox');
    expect(plugin.saveSettings).toHaveBeenCalledTimes(2);
  });
});
