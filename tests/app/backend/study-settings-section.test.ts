import { describe, expect, it, vi } from 'vitest';
const notices = vi.hoisted(() => [] as string[]);
vi.mock('obsidian', async () => ({
  ...await vi.importActual<object>('obsidian'),
  Notice: class { constructor(text: string) { notices.push(text); } },
  PluginSettingTab: class { containerEl: unknown; hidden = false; constructor(_app: unknown, _plugin: unknown) {} hide() { this.hidden = true; } },
}));
import { RecallSettingTab } from '../../../src/app/backend/settings';
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
  indeterminate = false;
  scrollTop = 0;
  scrollIntoView = vi.fn();
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
  byCls(cls: string) { return this.all().find(e => e.classes().includes(cls)); }
  /** Tag names of the listed rows, in order. */
  order() { return this.rows().map(r => r.all().find(e => e.cls === 'recall-tag-name')!.text.trim()); }
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
    expect(checkbox(sub)).toMatchObject({ checked: true, indeterminate: false, disabled: true });
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
    // Nothing followed, so the list is one group (with followed tags they come first: see "tag list" below).
    const { root } = await loaded([]);
    toggle(root).change(true);
    const expected = ['árboles', 'Archivo', 'Archivo/2024', 'arte', 'ciencia-de-datos', 'dev', 'English', 'German', 'German/aprendizaje',
      'German/grammar', 'German-old', 'Viajes', 'Viajes/Ávila', 'Zoo'];
    expect(names(root)).toEqual(expected);
    const reversed = await loaded([], { ...LISTING, tags: [...LISTING.tags].reverse() });
    toggle(reversed.root).change(true);
    expect(names(reversed.root)).toEqual(expected);
  });

  it('unsaved ticks and edited numbers survive toggling and filtering, and Aplicar ignores visibility', async () => {
    const { client, root, section } = await loaded();
    let filter = root.all().find(e => e.type === 'search')!;
    root.field('Tarjetas nuevas por día').change('7');
    checkbox(rowFor(root, 'English')).checked = true;
    checkbox(rowFor(root, 'English')).listeners.change();
    toggle(root).change(true);
    checkbox(rowFor(root, 'dev')).checked = true;
    checkbox(rowFor(root, 'dev')).listeners.change();
    // Ticks redraw only the list; a full redraw keeps the toggle, the numbers and the ticks.
    section.render();
    expect(toggle(root).value).toBe(true);
    expect(checkbox(rowFor(root, 'dev')).checked).toBe(true);
    filter = root.all().find(e => e.type === 'search')!;
    filter.value = 'zoo'; filter.listeners.input();
    toggle(root).change(false);
    expect(names(root)).toEqual(['Zoo']);
    expect(root.field('Tarjetas nuevas por día').value).toBe('7');
    expect(root.texts()).toMatch(/Seleccionados: dev, English, German\./);
    await click(root, 'Aplicar…');
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
    await click(root, 'Aplicar…');
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
    expect(notify).toHaveBeenCalledWith('Recall: ajustes de estudio guardados. Tags: German, Spanish.');
    expect(client.getStudySettings).toHaveBeenCalledTimes(2);
  });

  it('cancel keeps the draft and sends nothing else', async () => {
    const { client, root, section } = setup();
    await section.load();
    root.field('Orden aleatorio').change(false);
    await click(root, 'Aplicar…');
    await click(root, 'Cancelar');
    expect(root.texts()).not.toMatch(/Confirmar cambios/);
    expect(section.changes()).toEqual({ shuffleReviews: false });
    expect(client.updateStudySettings).toHaveBeenCalledTimes(1);
  });

  it('refuses invalid numbers and empty changes without calling the backend', async () => {
    const { client, root, section } = setup();
    await section.load();
    expect(root.button('Aplicar…')).toBeUndefined(); // no changes: no bar, no button
    await section.preview();
    expect(root.texts()).toMatch(/No hay cambios/);
    root.field('Repasos por día').change('-3');
    expect(root.byCls('recall-study-pending')!.texts()).toMatch(/repasos\/día: «-3» no es válido/);
    await click(root, 'Aplicar…');
    expect(root.texts()).toMatch(/enteros ≥ 0/);
    expect(client.updateStudySettings).not.toHaveBeenCalled();
  });

  it('on 409 reloads and tells the user (dry run or confirmation)', async () => {
    const conflict = new RemoteError(409, 'Settings changed on another device; reload them');
    const { client, root, section, notify } = setup();
    await section.load();
    root.field('Umbral de leech').change('4');
    client.updateStudySettings.mockRejectedValueOnce(conflict);
    await click(root, 'Aplicar…');
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/cambiaron en otro dispositivo/));
    expect(client.getStudySettings).toHaveBeenCalledTimes(2);
    expect(section.changes()).toEqual({});

    root.field('Umbral de leech').change('4');
    await click(root, 'Aplicar…');
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
    root.field('Umbral de leech').change('4');
    await click(root, 'Aplicar…');
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

const bar = (root: FakeEl) => root.byCls('recall-study-pending');
const sticky = (root: FakeEl) => root.byCls('recall-study-sticky')!;
const tick = (root: FakeEl, tag: string, on: boolean) => { const box = checkbox(rowFor(root, tag)); box.checked = on; box.listeners.change(); };

describe('Estudio settings section: pending changes bar', () => {
  it('appears with each kind of change, lists them, and disappears when the form matches the server again', async () => {
    const { root, section } = setup();
    await section.load();
    expect(bar(root)).toBeUndefined();
    expect(root.byCls('recall-study-sticky')!.children).toHaveLength(0);

    tick(root, 'Spanish', true);
    expect(bar(root)!.texts()).toMatch(/^Cambios sin aplicar \(1\): \+Spanish$/m);
    tick(root, 'German', false);
    expect(bar(root)!.texts()).toMatch(/Cambios sin aplicar \(2\): \+Spanish, −German$/m);
    root.field('Tarjetas nuevas por día').change('30');
    root.field('Repasos por día').change('100');
    root.field('Umbral de leech').change('4');
    root.field('Orden aleatorio').change(false);
    expect(bar(root)!.texts()).toMatch(
      /Cambios sin aplicar \(6\): \+Spanish, −German · nuevas\/día 20 → 30 · repasos\/día sin límite → 100 · umbral de leech 8 → 4 · orden aleatorio sí → no/);
    // The bar sits in the sticky area at the top of the section, with both actions.
    expect(sticky(root).byCls('recall-study-pending')).toBe(bar(root));
    expect(root.children.indexOf(sticky(root))).toBe(1); // right after the "Estudio" heading
    expect(root.button('Aplicar…')).toBeDefined();
    expect(root.button('Descartar')).toBeDefined();

    // Undo each change one by one: the bar shrinks, then goes away.
    tick(root, 'Spanish', false);
    tick(root, 'German', true);
    root.field('Tarjetas nuevas por día').change('20');
    root.field('Repasos por día').change('0');
    root.field('Umbral de leech').change('8');
    expect(bar(root)!.texts()).toMatch(/Cambios sin aplicar \(1\): orden aleatorio sí → no/);
    root.field('Orden aleatorio').change(true);
    expect(bar(root)).toBeUndefined();
    expect(section.isDirty()).toBe(false);
  });

  it('lists many tag changes briefly', async () => {
    const many: TagListing = { tags: Array.from({ length: 12 }, (_, i) => ({ tag: `t${String(i).padStart(2, '0')}`, notes: 1, cards: 1, selected: false, followed: false })), untagged: { notes: 0, cards: 0, followed: false } };
    const { root, section } = setup({ getTags: vi.fn(async () => many) });
    await section.load();
    for (let i = 0; i < 10; i++) tick(root, `t0${i}`, true);
    expect(bar(root)!.texts()).toMatch(/Cambios sin aplicar \(10\): \+t00, .*\+t07, y 2 tags más$/m);
  });

  it('Descartar restores the loaded state', async () => {
    const { client, root, section } = setup();
    await section.load();
    tick(root, 'Spanish', true);
    root.field('Tarjetas nuevas por día').change('5');
    root.field('Umbral de leech').change('x');
    await click(root, 'Descartar');
    expect(section.changes()).toEqual({});
    expect(section.isDirty()).toBe(false);
    expect(bar(root)).toBeUndefined();
    expect(checkbox(rowFor(root, 'Spanish')).checked).toBe(false);
    expect(root.field('Tarjetas nuevas por día').value).toBe('20');
    expect(root.field('Umbral de leech').value).toBe('8');
    expect(root.texts()).toMatch(/Seleccionados: German\./);
    expect(client.updateStudySettings).not.toHaveBeenCalled();
  });

  it('keeps "Seleccionados" in sync with the form', async () => {
    const { root, section } = setup();
    await section.load();
    tick(root, 'Spanish', true);
    expect(root.byCls('recall-tags-summary')!.texts()).toBe('Seleccionados: German, Spanish.');
  });
});

describe('Estudio settings section: confirmation', () => {
  it('shows the confirmation in the sticky area, focuses Confirmar, locks the form, and confirms the previewed command', async () => {
    const { client, root, section } = setup();
    await section.load();
    tick(root, 'Spanish', true);
    root.field('Umbral de leech').change('4');
    const stickyBefore = sticky(root);
    await click(root, 'Aplicar…');
    const box = sticky(root).byCls('recall-settings-confirm')!;
    expect(box.texts()).toMatch(/Confirmar cambios de estudio/);
    expect(box.texts()).toMatch(/Umbral de leech: 4\./);
    expect(box.texts()).not.toMatch(/anguijuela/);
    expect(bar(root)).toBeUndefined(); // the confirmation replaces the pending bar
    expect(root.button('Confirmar').buttonEl.focused).toBe(true);
    expect(sticky(root).scrollIntoView).toHaveBeenCalled();
    expect(stickyBefore).not.toBe(sticky(root));

    // Locked: every input is disabled and edits through the handlers are ignored.
    expect(root.rows().every(r => checkbox(r).disabled)).toBe(true);
    for (const name of ['Tarjetas nuevas por día', 'Repasos por día', 'Umbral de leech', 'Orden aleatorio']) expect(root.field(name).disabled).toBe(true);
    section.setTag('Spanish', false);
    section.setNumber('dailyNewLimit', '99');
    section.setShuffle(false);
    section.discard();
    expect(section.changes()).toEqual({ flashcardTags: ['German', 'Spanish'], leechThreshold: 4 });
    expect(root.byCls('recall-settings-confirm')).toBeDefined();

    await click(root, 'Confirmar');
    const [dry, real] = client.updateStudySettings.mock.calls.map(c => c[0]);
    const { dryRun, ...previewed } = dry;
    expect(real).toEqual(previewed);
    expect(real.settings).toEqual({ flashcardTags: ['German', 'Spanish'], leechThreshold: 4 });
  });

  it('Cancelar unlocks the form with the draft intact', async () => {
    const { root, section } = setup();
    await section.load();
    root.field('Tarjetas nuevas por día').change('5');
    await click(root, 'Aplicar…');
    await click(root, 'Cancelar');
    expect(root.field('Tarjetas nuevas por día').disabled).toBe(false);
    expect(root.field('Tarjetas nuevas por día').value).toBe('5');
    expect(bar(root)!.texts()).toMatch(/nuevas\/día 20 → 5/);
    section.setNumber('dailyNewLimit', '6');
    expect(section.changes()).toEqual({ dailyNewLimit: 6 });
  });

  it('after saving, says so with the tags and the status line reports the stored settings', async () => {
    const getStudySettings = vi.fn()
      .mockResolvedValueOnce(structuredClone(STATE))
      .mockResolvedValue({ ...structuredClone(STATE), settings: { ...STATE.settings, flashcardTags: ['German', 'Spanish'] }, source: 'stored', revision: 1 });
    const { root, section, notify } = setup({ getStudySettings });
    await section.load();
    expect(root.byCls('recall-study-status')!.text).toMatch(/valores de su entorno/);
    tick(root, 'Spanish', true);
    await click(root, 'Aplicar…');
    await click(root, 'Confirmar');
    expect(notify).toHaveBeenCalledWith('Recall: ajustes de estudio guardados. Tags: German, Spanish.');
    expect(root.byCls('recall-study-status')!.text).toMatch(/^Guardados en el servidor \(revisión 1\)/);
    expect(bar(root)).toBeUndefined();
    expect(root.byCls('recall-settings-confirm')).toBeUndefined();
  });
});

describe('Estudio settings section: leaving the settings tab', () => {
  async function openTab() {
    notices.length = 0;
    const plugin = { settings: loadPluginSettings({}), saveSettings: vi.fn(async () => {}) };
    const client = {
      isConfigured: () => true,
      getStudySettings: vi.fn(async () => structuredClone(STATE)),
      getTags: vi.fn(async () => structuredClone(TAGS)),
      updateStudySettings: vi.fn(),
      notifyChanged: vi.fn(),
    };
    const tab: any = new RecallSettingTab({} as any, plugin as any, client);
    tab.containerEl = new FakeEl('div');
    tab.display();
    const root = (tab.containerEl as FakeEl).byCls('recall-study-settings')!;
    await vi.waitFor(() => expect(root.texts()).toMatch(/Seleccionados: German/));
    return { tab, client, root };
  }

  it('with pending changes: tells the user they were not saved, and saves nothing', async () => {
    const { tab, client, root } = await openTab();
    tick(root, 'Spanish', true);
    tab.hide();
    expect(notices).toEqual(['Recall: había cambios de estudio sin aplicar; no se han guardado.']);
    expect(client.updateStudySettings).not.toHaveBeenCalled();
    expect(tab.hidden).toBe(true);
  });

  it('with a confirmation still open: same notice, nothing sent', async () => {
    const { tab, client, root } = await openTab();
    client.updateStudySettings.mockResolvedValue({ ...structuredClone(STATE), impact: IMPACT, dryRun: true });
    root.field('Umbral de leech').change('3');
    await click(root, 'Aplicar…');
    tab.hide();
    expect(notices).toHaveLength(1);
    expect(client.updateStudySettings).toHaveBeenCalledTimes(1); // the dry run only
  });

  it('without changes: says nothing', async () => {
    const { tab } = await openTab();
    tab.hide();
    expect(notices).toEqual([]);
    expect(tab.hidden).toBe(true);
  });
});

describe('Estudio settings section: tag list', () => {
  const LISTING: TagListing = {
    tags: [
      { tag: 'zoo', notes: 1, cards: 1, selected: false, followed: false },
      { tag: 'history-modern', notes: 1, cards: 2, selected: false, followed: false },
      { tag: 'history/medieval', notes: 1, cards: 2, selected: false, followed: false },
      { tag: 'history', notes: 1, cards: 0, selected: false, followed: false },
      { tag: 'German/grammar', notes: 1, cards: 3, selected: false, followed: true },
      { tag: 'German', notes: 3, cards: 4, selected: true, followed: true },
      { tag: 'dev', notes: 1, cards: 0, selected: true, followed: true },
      { tag: 'Biology', notes: 1, cards: 0, selected: false, followed: false },
      { tag: 'art', notes: 2, cards: 2, selected: false, followed: false },
    ],
    untagged: { notes: 0, cards: 0, followed: false },
  };
  const LOADED: StudySettingsState = { ...STATE, settings: { ...STATE.settings, flashcardTags: ['German', 'dev'] } };
  const load = async () => {
    const t = setup({ getTags: vi.fn(async () => structuredClone(LISTING)), getStudySettings: vi.fn(async () => structuredClone(LOADED)) });
    await t.section.load();
    return t;
  };

  it('followed tags first, then the rest alphabetically (case-insensitive, parents before sub-tags), with group titles', async () => {
    const { root } = await load();
    // Biology has no cards: hidden. history has none either, but it is the parent of a listed tag.
    expect(root.order()).toEqual(['dev', 'German', 'German/grammar', 'art', 'history', 'history/medieval', 'history-modern', 'zoo']);
    expect(root.all().filter(e => e.cls === 'recall-tags-group').map(e => e.text)).toEqual(['Seguidos ahora', 'Otros tags']);
    expect(rowFor(root, 'German/grammar').style.paddingLeft).toBe('16px');
    expect(rowFor(root, 'history/medieval').style.paddingLeft).toBe('16px');
    expect(rowFor(root, 'history-modern').style.paddingLeft).toBe('0px');
  });

  it('ticking a box does not move rows', async () => {
    const { root } = await load();
    const before = root.order();
    tick(root, 'zoo', true);
    tick(root, 'German', false);
    expect(root.order()).toEqual(before);
  });

  it('hides tags without cards behind a toggle; a selected tag is always shown', async () => {
    const { root } = await load();
    const toggle = root.field('Mostrar tags sin tarjetas');
    expect(toggle.value).toBe(false);
    expect(root.texts()).toMatch(/^1 tag sin tarjetas oculto\.$/m); // Biology; history is a listed parent, dev is selected
    expect(root.order()).not.toContain('Biology');
    expect(root.order()).toContain('dev'); // selected, 0 cards
    toggle.change(true);
    expect(root.order()).toEqual(['dev', 'German', 'German/grammar', 'art', 'Biology', 'history', 'history/medieval', 'history-modern', 'zoo']);
    tick(root, 'Biology', true);
    toggle.change(false);
    expect(root.order()).toContain('Biology'); // selected in the form: stays visible
  });

  it('renders sub-tags covered by a selected parent differently from hand-selected tags', async () => {
    const { root } = await load();
    const parent = rowFor(root, 'German'), sub = rowFor(root, 'German/grammar'), free = rowFor(root, 'art');
    expect(parent.cls).toBe('recall-tag-row is-selected recall-tag-selected');
    expect(checkbox(parent)).toMatchObject({ checked: true, indeterminate: false, disabled: false });
    expect(sub.cls).toBe('recall-tag-row is-covered recall-tag-covered');
    // Included through its parent: ticked but greyed out (see styles.css), not editable on its own.
    expect(checkbox(sub)).toMatchObject({ checked: true, indeterminate: false, disabled: true });
    expect(sub.texts()).toMatch(/incluido por German/);
    expect(free.cls).toBe('recall-tag-row');
    expect(checkbox(free)).toMatchObject({ checked: false, indeterminate: false, disabled: false });
  });

  it('the filter also lists the parents of its matches', async () => {
    const { root, section } = await load();
    section.filter = 'medieval';
    section.render();
    expect(root.order()).toEqual(['history', 'history/medieval']);
    section.filter = 'GRAMMAR';
    section.render();
    expect(root.order()).toEqual(['German', 'German/grammar']);
  });

  it('explains where followed tags show up', async () => {
    const { root } = await load();
    expect(root.texts()).toMatch(/aparecen como mazos en Obsidian y en la app de Android después de aplicar/);
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
