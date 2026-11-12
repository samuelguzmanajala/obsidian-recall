import { describe, expect, it, vi } from 'vitest';
import { StudySettingsSection, type StudySettingsClient } from '../../../src/app/backend/study-settings-section';
import { RemoteClient, RemoteError } from '../../../src/app/backend/remote-client';
import { loadPluginSettings } from '../../../src/app/backend/plugin-settings';
import type { SettingsUpdateResult, StudySettingsState, TagListing } from '../../../src/app/backend/study-client';

/** Just enough of Obsidian's element helpers to read back what the section rendered. */
class FakeEl {
  children: FakeEl[] = [];
  text = '';
  style: Record<string, string> = {};
  checked = false;
  disabled = false;
  value = '';
  setting?: any;
  listeners: Record<string, () => void> = {};
  constructor(readonly tag: string, options: { text?: string; cls?: string; type?: string; value?: string } = {}) {
    this.text = options.text ?? '';
    this.value = options.value ?? '';
    this.cls = options.cls ?? '';
    this.type = options.type ?? '';
  }
  cls: string;
  type: string;
  empty() { this.children = []; }
  createEl(tag: string, options?: { text?: string; cls?: string; type?: string; value?: string }) { const el = new FakeEl(tag, options); this.children.push(el); return el; }
  createDiv(options?: { cls?: string }) { return this.createEl('div', options); }
  createSpan(options?: { text?: string; cls?: string }) { return this.createEl('span', options); }
  addEventListener(event: string, f: () => void) { this.listeners[event] = f; }
  all(): FakeEl[] { return [this, ...this.children.flatMap(c => c.all())]; }
  texts(): string { return this.all().map(e => e.text).filter(Boolean).join('\n'); }
  settings(): any[] { return this.all().filter(e => e.setting).map(e => e.setting); }
  button(text: string) { return this.settings().flatMap(s => s.components).find((c: any) => c.text === text); }
  field(name: string) { return this.settings().find(s => s.name === name)?.components[0]; }
  classes(): string[] { return this.cls.split(' ').filter(Boolean); }
  rows() { return this.all().filter(e => e.classes().includes('recall-tag-row')); }
}
/** Buttons run async handlers without returning them: click, then let the handler finish. */
async function click(root: FakeEl, text: string) {
  root.button(text).click();
  await new Promise(r => setTimeout(r, 0));
}
const rowFor = (root: FakeEl, tag: string) => root.rows().find(r => r.all().some(e => e.text === ` ${tag}`))!;
const checkbox = (row: FakeEl) => row.all().find(e => e.type === 'checkbox')!;

const STATE: StudySettingsState = {
  settings: { flashcardTags: ['German'], dailyNewLimit: 20, dailyReviewLimit: 0, leechThreshold: 8, shuffleReviews: true },
  source: 'environment', revision: 0,
};
const TAGS: TagListing = {
  tags: [
    { tag: 'German', notes: 3, cards: 4, selected: true, followed: true },
    { tag: 'German/grammar', notes: 1, cards: 3, selected: false, followed: true },
    { tag: 'Spanish', notes: 1, cards: 1, selected: false, followed: false },
  ],
  untagged: { notes: 2, cards: 5, followed: false },
};
const IMPACT = { notes: 5, cardsBefore: 4, cardsAfter: 5, cardsAdded: 1, cardsRemoved: 0, decksBefore: 3, decksAfter: 4 };

function setup(overrides: Partial<StudySettingsClient> = {}) {
  const client = {
    isConfigured: () => true,
    getStudySettings: vi.fn(async () => structuredClone(STATE)),
    getTags: vi.fn(async () => structuredClone(TAGS)),
    updateStudySettings: vi.fn(async (cmd: any): Promise<SettingsUpdateResult> => ({
      settings: { ...STATE.settings, ...cmd.settings }, source: 'stored', revision: 1, impact: IMPACT, ...(cmd.dryRun ? { dryRun: true } : {}),
    })),
    notifyChanged: vi.fn(),
    ...overrides,
  };
  const root = new FakeEl('div');
  const notify = vi.fn();
  const section = new StudySettingsSection(root as unknown as HTMLElement, client, notify);
  return { client, root, section, notify };
}

describe('Estudio settings section: states', () => {
  it('not configured: explains it and never calls the backend', async () => {
    const { client, root, section } = setup({ isConfigured: () => false });
    await section.load();
    expect(root.texts()).toMatch(/Configura la URL y el token del backend/);
    expect(root.texts()).not.toMatch(/Estudio/);
    expect(client.getStudySettings).not.toHaveBeenCalled();
  });

  it('loading, then loaded with tags, counts, sub-tags covered by a selected parent and the empty-selection rule', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const { root, section } = setup({ getStudySettings: vi.fn(async () => { await gate; return structuredClone(STATE); }) });
    const loading = section.load();
    expect(root.texts()).toMatch(/Cargando ajustes de estudio/);
    release(); await loading;
    expect(section.state).toBe('loaded');
    const text = root.texts();
    expect(text).toMatch(/valores de su entorno/);
    expect(text).toMatch(/Seleccionados: German\./);
    expect(text).toMatch(/Notas sin tags: 2 notas, 5 tarjetas\. Solo se estudian si no seleccionas ningún tag/);
    expect(rowFor(root, 'German').texts()).toMatch(/3 notas, 4 tarjetas/);
    const sub = rowFor(root, 'German/grammar');
    expect(checkbox(sub)).toMatchObject({ checked: true, disabled: true });
    expect(sub.texts()).toMatch(/incluido por German/);
    expect(sub.style.paddingLeft).toBe('16px');
    expect(checkbox(rowFor(root, 'Spanish'))).toMatchObject({ checked: false, disabled: false });
    expect(root.field('Tarjetas nuevas por día').value).toBe('20');
    expect(root.field('Orden aleatorio').value).toBe(true);
    expect(root.button('Volver a los valores del entorno')).toBeUndefined();

    checkbox(rowFor(root, 'German')).checked = false;
    checkbox(rowFor(root, 'German')).listeners.change();
    expect(root.texts()).toMatch(/Ningún tag seleccionado: se estudian todas las notas con tarjetas/);
    expect(checkbox(rowFor(root, 'German/grammar')).disabled).toBe(false);
  });

  it('error: shows the reason and retries', async () => {
    const getTags = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(structuredClone(TAGS));
    const { root, section } = setup({ getTags });
    await section.load();
    expect(section.state).toBe('error');
    expect(root.texts()).toMatch(/No se pudieron cargar los ajustes de estudio: offline/);
    await click(root, 'Reintentar');
    await vi.waitFor(() => expect(section.state).toBe('loaded'));
  });

  it('shows a filter box for long tag lists', async () => {
    const many: TagListing = { tags: Array.from({ length: 20 }, (_, i) => ({ tag: `t${i}`, notes: 1, cards: 1, selected: false, followed: false })), untagged: { notes: 0, cards: 0, followed: false } };
    const { root, section } = setup({ getTags: vi.fn(async () => many) });
    await section.load();
    const filter = root.all().find(e => e.type === 'search')!;
    expect(root.rows()).toHaveLength(20);
    filter.value = 't1'; filter.listeners.input();
    expect(root.rows().map(r => r.texts())).toHaveLength(11); // t1, t10…t19
    filter.value = 'zzz'; filter.listeners.input();
    expect(root.texts()).toMatch(/Ningún tag coincide/);
  });
});

describe('Estudio settings section: tag list visibility, order and covered rows', () => {
  const tag = (name: string, cards: number, notes = 1) => ({ tag: name, notes, cards, selected: false, followed: false });
  const LISTING: TagListing = {
    tags: [
      tag('German/aprendizaje', 0), tag('dev', 0), tag('Viajes', 0), tag('Viajes/Ávila', 0),
      tag('German', 4, 3), tag('German/grammar', 3), tag('English', 2), tag('ciencia-de-datos', 5),
      tag('árboles', 1), tag('Zoo', 1), tag('arte', 1), tag('Archivo', 0), tag('Archivo/2024', 2), tag('German-old', 1),
    ],
    untagged: { notes: 0, cards: 0, followed: false },
  };
  const names = (root: FakeEl) => root.rows().map(r => r.all().find(e => e.classes().includes('recall-tag-name'))!.text.trim());
  const toggle = (root: FakeEl) => root.field('Mostrar tags sin tarjetas');
  async function loaded(selected: string[] = ['German'], listing: TagListing = LISTING) {
    const ctx = setup({
      getStudySettings: vi.fn(async () => ({ ...structuredClone(STATE), settings: { ...STATE.settings, flashcardTags: selected } })),
      getTags: vi.fn(async () => structuredClone(listing)),
    });
    await ctx.section.load();
    return ctx;
  }

  it('hides zero-card tags by default and says how many, keeping ancestors of listed tags', async () => {
    const { root } = await loaded();
    expect(names(root)).not.toContain('German/aprendizaje');
    expect(names(root)).not.toContain('dev');
    expect(names(root)).not.toContain('Viajes/Ávila');
    expect(names(root)).toContain('Archivo'); // 0 cards, but parent of Archivo/2024
    expect(root.texts()).toMatch(/4 tags sin tarjetas ocultos\./);
    expect(toggle(root).value).toBe(false);
  });

  it('a selected zero-card tag stays visible so it can be unticked, and its ancestors with it', async () => {
    const { root } = await loaded(['Viajes/Ávila']);
    expect(names(root)).toEqual(expect.arrayContaining(['Viajes', 'Viajes/Ávila']));
    expect(checkbox(rowFor(root, 'Viajes/Ávila'))).toMatchObject({ checked: true, disabled: false });
    checkbox(rowFor(root, 'Viajes/Ávila')).checked = false;
    checkbox(rowFor(root, 'Viajes/Ávila')).listeners.change();
    // Still listed (selected on the server), so the untick can be undone.
    expect(names(root)).toContain('Viajes/Ávila');
    expect(root.texts()).toMatch(/Ningún tag seleccionado/);
  });

  it('the toggle shows every tag, and the filter only reaches hidden tags when it is on', async () => {
    const { root } = await loaded();
    const filter = root.all().find(e => e.type === 'search')!;
    filter.value = 'aprend'; filter.listeners.input();
    expect(names(root)).toEqual([]);
    expect(root.texts()).toMatch(/Ningún tag coincide/);
    expect(root.texts()).toMatch(/4 tags sin tarjetas ocultos/); // unfiltered count: stable while typing
    toggle(root).change(true);
    expect(names(root)).toEqual(['German', 'German/aprendizaje']);
    expect(root.texts()).not.toMatch(/ocultos/);
    filter.value = ''; filter.listeners.input();
    expect(names(root)).toHaveLength(LISTING.tags.length);
    toggle(root).change(false);
    expect(names(root)).toHaveLength(LISTING.tags.length - 4);
  });

  it('a filter keeps the ancestors of matching tags', async () => {
    const { root } = await loaded();
    const filter = root.all().find(e => e.type === 'search')!;
    filter.value = 'grammar'; filter.listeners.input();
    expect(names(root)).toEqual(['German', 'German/grammar']);
  });

  it('marks covered rows as muted and disabled, explicit selections as selected', async () => {
    const { root } = await loaded();
    const covered = rowFor(root, 'German/grammar');
    expect(covered.classes()).toContain('recall-tag-covered');
    expect(covered.classes()).not.toContain('recall-tag-selected');
    expect(checkbox(covered)).toMatchObject({ checked: true, disabled: true });
    expect(covered.texts()).toMatch(/incluido por German/);
    const explicit = rowFor(root, 'German');
    expect(explicit.classes()).toContain('recall-tag-selected');
    expect(explicit.classes()).not.toContain('recall-tag-covered');
    expect(checkbox(explicit)).toMatchObject({ checked: true, disabled: false });
    expect(rowFor(root, 'English').classes()).toEqual(['recall-tag-row']);
  });

  it('sorts case- and accent-insensitively with parents right before their sub-tags, whatever the server order', async () => {
    const { root } = await loaded();
    toggle(root).change(true);
    const expected = ['árboles', 'Archivo', 'Archivo/2024', 'arte', 'ciencia-de-datos', 'dev', 'English', 'German', 'German/aprendizaje',
      'German/grammar', 'German-old', 'Viajes', 'Viajes/Ávila', 'Zoo'];
    expect(names(root)).toEqual(expected);
    const reversed = await loaded(['German'], { ...LISTING, tags: [...LISTING.tags].reverse() });
    toggle(reversed.root).change(true);
    expect(names(reversed.root)).toEqual(expected);
  });

  it('unsaved ticks and edited numbers survive toggling and filtering, and Aplicar ignores visibility', async () => {
    const { client, root } = await loaded();
    const filter = root.all().find(e => e.type === 'search')!;
    root.field('Tarjetas nuevas por día').change('7');
    checkbox(rowFor(root, 'English')).checked = true;
    checkbox(rowFor(root, 'English')).listeners.change();
    toggle(root).change(true);
    checkbox(rowFor(root, 'dev')).checked = true;
    checkbox(rowFor(root, 'dev')).listeners.change();
    expect(toggle(root).value).toBe(true); // a full redraw keeps the toggle
    filter.value = 'zoo'; filter.listeners.input();
    toggle(root).change(false);
    expect(names(root)).toEqual(['Zoo']);
    expect(root.field('Tarjetas nuevas por día').value).toBe('7');
    expect(root.texts()).toMatch(/Seleccionados: dev, English, German\./);
    await click(root, 'Aplicar');
    expect(client.updateStudySettings.mock.calls[0][0].settings).toEqual({ flashcardTags: ['English', 'German', 'dev'], dailyNewLimit: 7 });
  });
});

describe('Estudio settings section: applying', () => {
  it('runs a dry run, shows the impact, then sends the same command and refreshes the views', async () => {
    const { client, root, section, notify } = setup();
    await section.load();
    checkbox(rowFor(root, 'Spanish')).checked = true;
    checkbox(rowFor(root, 'Spanish')).listeners.change();
    root.field('Tarjetas nuevas por día').change('5');
    await click(root, 'Aplicar');
    expect(client.updateStudySettings).toHaveBeenCalledTimes(1);
    const dry = client.updateStudySettings.mock.calls[0][0];
    expect(dry).toEqual({ operationId: expect.any(String), expectedRevision: 0, settings: { flashcardTags: ['German', 'Spanish'], dailyNewLimit: 5 }, dryRun: true });
    const text = root.texts();
    expect(text).toMatch(/Confirmar cambios de estudio/);
    expect(text).toMatch(/Se reindexarán 5 notas publicadas/);
    expect(text).toMatch(/Tarjetas: 4 → 5 \(\+1, −0\)/);
    expect(text).toMatch(/Mazos con tarjetas: 3 → 4/);
    expect(client.notifyChanged).not.toHaveBeenCalled();

    await click(root, 'Confirmar');
    const { dryRun, ...real } = dry;
    expect(dryRun).toBe(true);
    expect(client.updateStudySettings.mock.calls[1][0]).toEqual(real);
    expect(client.notifyChanged).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/aplicados/));
    expect(client.getStudySettings).toHaveBeenCalledTimes(2);
  });

  it('cancel keeps the draft and sends nothing else', async () => {
    const { client, root, section } = setup();
    await section.load();
    root.field('Orden aleatorio').change(false);
    await click(root, 'Aplicar');
    await click(root, 'Cancelar');
    expect(root.texts()).not.toMatch(/Confirmar cambios/);
    expect(section.changes()).toEqual({ shuffleReviews: false });
    expect(client.updateStudySettings).toHaveBeenCalledTimes(1);
  });

  it('refuses invalid numbers and empty changes without calling the backend', async () => {
    const { client, root, section } = setup();
    await section.load();
    await click(root, 'Aplicar');
    expect(root.texts()).toMatch(/No hay cambios/);
    root.field('Repasos por día').change('-3');
    await click(root, 'Aplicar');
    expect(root.texts()).toMatch(/enteros ≥ 0/);
    expect(client.updateStudySettings).not.toHaveBeenCalled();
  });

  it('on 409 reloads and tells the user (dry run or confirmation)', async () => {
    const conflict = new RemoteError(409, 'Settings changed on another device; reload them');
    const { client, root, section, notify } = setup();
    await section.load();
    root.field('Umbral de sanguijuela').change('4');
    client.updateStudySettings.mockRejectedValueOnce(conflict);
    await click(root, 'Aplicar');
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/cambiaron en otro dispositivo/));
    expect(client.getStudySettings).toHaveBeenCalledTimes(2);
    expect(section.changes()).toEqual({});

    root.field('Umbral de sanguijuela').change('4');
    await click(root, 'Aplicar');
    client.updateStudySettings.mockRejectedValueOnce(conflict);
    await click(root, 'Confirmar');
    expect(notify).toHaveBeenCalledTimes(2);
    expect(client.getStudySettings).toHaveBeenCalledTimes(3);
    expect(client.notifyChanged).not.toHaveBeenCalled();
    expect(root.texts()).not.toMatch(/Confirmar cambios/);
  });

  it('keeps the confirmation after another failure, so Confirmar retries the same operation', async () => {
    const { client, root, section } = setup();
    await section.load();
    root.field('Umbral de sanguijuela').change('4');
    await click(root, 'Aplicar');
    client.updateStudySettings.mockRejectedValueOnce(new Error('Backend connection timed out. Retry to confirm the result.'));
    await click(root, 'Confirmar');
    expect(root.texts()).toMatch(/No se pudo aplicar: Backend connection timed out/);
    await click(root, 'Confirmar');
    const [, first, retry] = client.updateStudySettings.mock.calls.map(c => c[0]);
    expect(retry).toEqual(first);
    expect(client.notifyChanged).toHaveBeenCalledTimes(1);
  });

  it('offers going back to the environment values when settings are stored', async () => {
    const { client, root, section } = setup({ getStudySettings: vi.fn(async () => ({ ...structuredClone(STATE), source: 'stored' as const, revision: 3 })) });
    await section.load();
    expect(root.texts()).toMatch(/revisión 3/);
    await click(root, 'Volver a los valores del entorno');
    expect(client.updateStudySettings.mock.calls[0][0]).toEqual({ operationId: expect.any(String), expectedRevision: 3, reset: true, dryRun: true });
  });
});

describe('RemoteClient study settings', () => {
  it('maps the three routes', async () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init!.method!, body: init!.body ? JSON.parse(String(init!.body)) : undefined });
      return new Response(JSON.stringify(String(url).endsWith('/tags') ? TAGS : STATE));
    });
    const client = new RemoteClient(loadPluginSettings({ backend: { url: 'http://localhost:27124/', token: 't', syncNotes: false } }), transport as typeof fetch);
    expect(await client.getStudySettings()).toEqual(STATE);
    expect(await client.getTags()).toEqual(TAGS);
    const command = { operationId: 'op', expectedRevision: 0, settings: { dailyNewLimit: 3 }, dryRun: true };
    await client.updateStudySettings(command);
    expect(calls).toEqual([
      { url: 'http://localhost:27124/api/v1/settings', method: 'GET', body: undefined },
      { url: 'http://localhost:27124/api/v1/tags', method: 'GET', body: undefined },
      { url: 'http://localhost:27124/api/v1/settings', method: 'POST', body: command },
    ]);
  });

  it('surfaces a 409 as a RemoteError with its status', async () => {
    const transport = vi.fn(async () => new Response(JSON.stringify({ error: 'Settings changed on another device; reload them' }), { status: 409 }));
    const client = new RemoteClient(loadPluginSettings({ backend: { url: 'http://localhost:27124', token: 't', syncNotes: false } }), transport as typeof fetch);
    await expect(client.updateStudySettings({ operationId: 'op', expectedRevision: 0, settings: { leechThreshold: 2 } }))
      .rejects.toMatchObject({ status: 409, message: 'Settings changed on another device; reload them' });
  });
});
