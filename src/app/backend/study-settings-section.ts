import { Notice, Setting } from 'obsidian';
import type { SettingsUpdate, SettingsUpdateResult, StudyClient, StudySettings, StudySettingsState, TagListing, TagSummary } from './study-client';

export type StudySettingsClient = Pick<StudyClient, 'isConfigured' | 'getStudySettings' | 'getTags' | 'updateStudySettings'> & {
  /** Asks the open views to refresh. */
  notifyChanged(): void;
};

/** Show the filter box above this many tags. */
const FILTER_FROM = 12;

function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown })?.status;
  return typeof status === 'number' ? status : undefined;
}
function message(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}
function sameTags(a: readonly string[], b: readonly string[]): boolean {
  const x = [...new Set(a)].sort(), y = [...new Set(b)].sort();
  return x.length === y.length && x.every((tag, i) => tag === y[i]);
}
/** The selected tag that covers `tag` (a strict ancestor), if any. */
function coveringTag(tag: string, selected: readonly string[]): string | undefined {
  return selected.find(s => s !== tag && tag.startsWith(s + '/'));
}
/**
 * Tree order: path segment by segment, case- and accent-insensitive (Spanish collation), so a
 * parent comes right before its sub-tags. Ties under that collation fall back to code units,
 * which makes the order total and independent of the server's.
 */
export function compareTags(a: string, b: string): number {
  const x = a.split('/'), y = b.split('/');
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const order = x[i].localeCompare(y[i], 'es', { sensitivity: 'base' });
    if (order) return order;
  }
  if (x.length !== y.length) return x.length - y.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
/** Strict ancestors of `tag` ("a/b/c" → "a", "a/b"). */
function ancestors(tag: string): string[] {
  const parts = tag.split('/');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * "Estudio" section of the settings tab: tags to follow, daily limits, leech threshold and
 * shuffle, stored on the backend. Loaded when the tab opens; every change goes through a dry
 * run and a confirmation. Never throws: failures are shown in the section.
 */
export class StudySettingsSection {
  state: 'loading' | 'error' | 'loaded' = 'loading';
  error: string | null = null;
  loaded: StudySettingsState | null = null;
  tags: TagListing | null = null;
  /** Edited values, applied only through "Aplicar". */
  draft: StudySettings | null = null;
  /** Text typed in the numeric fields that is not a valid number (field → text). */
  invalid = new Map<string, string>();
  filter = '';
  /** Show tags whose notes have no cards (hidden by default; not persisted). */
  showEmpty = false;
  /** Dry-run answer awaiting confirmation, with the command that produced it. */
  pending: { command: SettingsUpdate; preview: SettingsUpdateResult } | null = null;
  busy: 'preview' | 'apply' | null = null;
  notice: string | null = null;
  private listEl: HTMLElement | null = null;
  private hiddenEl: HTMLElement | null = null;

  constructor(
    private readonly containerEl: HTMLElement,
    private readonly client: StudySettingsClient,
    private readonly notify: (text: string) => void = text => { new Notice(text); },
  ) {}

  async load(): Promise<void> {
    if (!this.client.isConfigured()) { this.render(); return; }
    this.state = 'loading';
    this.pending = null;
    this.render();
    try {
      const [loaded, tags] = await Promise.all([this.client.getStudySettings(), this.client.getTags()]);
      this.loaded = loaded;
      this.tags = tags;
      this.draft = { ...loaded.settings, flashcardTags: [...loaded.settings.flashcardTags] };
      this.invalid.clear();
      this.state = 'loaded';
      this.error = null;
    } catch (error) {
      this.state = 'error';
      this.error = message(error);
    }
    this.render();
  }

  /** Fields that differ from what the backend has. */
  changes(): Partial<StudySettings> {
    if (!this.loaded || !this.draft) return {};
    const before = this.loaded.settings, after = this.draft;
    const out: Partial<StudySettings> = {};
    if (!sameTags(before.flashcardTags, after.flashcardTags)) out.flashcardTags = [...after.flashcardTags].sort();
    for (const key of ['dailyNewLimit', 'dailyReviewLimit', 'leechThreshold', 'shuffleReviews'] as const) {
      if (before[key] !== after[key]) (out as Record<string, unknown>)[key] = after[key];
    }
    return out;
  }

  setTag(tag: string, on: boolean): void {
    if (!this.draft) return;
    const tags = this.draft.flashcardTags.filter(t => t !== tag);
    if (on) tags.push(tag);
    this.draft.flashcardTags = tags;
    this.pending = null;
    this.render();
  }

  setNumber(key: 'dailyNewLimit' | 'dailyReviewLimit' | 'leechThreshold', text: string): void {
    if (!this.draft) return;
    this.dropPreview();
    const value = Number(text.trim());
    if (text.trim() === '' || !Number.isSafeInteger(value) || value < 0) { this.invalid.set(key, text); return; }
    this.invalid.delete(key);
    this.draft[key] = value;
  }

  setShuffle(on: boolean): void {
    if (!this.draft) return;
    this.dropPreview();
    this.draft.shuffleReviews = on;
  }

  /** "Aplicar": dry run, then show what would change. `reset`: back to the server's environment values. */
  async preview(reset = false): Promise<void> {
    if (!this.loaded || this.busy) return;
    if (!reset && this.invalid.size) { this.notice = 'Corrige los campos numéricos: deben ser enteros ≥ 0.'; this.render(); return; }
    const settings = this.changes();
    if (!reset && !Object.keys(settings).length) { this.notice = 'No hay cambios que aplicar.'; this.render(); return; }
    const command: SettingsUpdate = {
      operationId: crypto.randomUUID(), expectedRevision: this.loaded.revision, ...(reset ? { reset: true } : { settings }),
    };
    this.busy = 'preview';
    this.notice = null;
    this.render();
    try {
      const preview = await this.client.updateStudySettings({ ...command, dryRun: true });
      this.pending = { command, preview };
    } catch (error) {
      this.busy = null;
      await this.failed(error);
    }
    this.busy = null;
    this.render();
  }

  /** An edit invalidates a confirmation on screen (the fields keep focus otherwise: no re-render). */
  private dropPreview(): void {
    if (!this.pending) return;
    this.pending = null;
    this.render();
  }

  cancel(): void {
    this.pending = null;
    this.render();
  }

  /** Sends the command that was previewed (same operationId: a retry after a lost answer is safe). */
  async confirm(): Promise<void> {
    if (!this.pending || this.busy) return;
    this.busy = 'apply';
    this.notice = null;
    this.render();
    try {
      await this.client.updateStudySettings(this.pending.command);
    } catch (error) {
      this.busy = null;
      await this.failed(error);
      this.render();
      return;
    }
    this.pending = null;
    this.busy = null;
    this.notify('Recall: ajustes de estudio aplicados.');
    this.client.notifyChanged();
    await this.load();
  }

  private async failed(error: unknown): Promise<void> {
    if (errorStatus(error) === 409) {
      this.pending = null;
      this.notify('Recall: los ajustes de estudio cambiaron en otro dispositivo. Se han recargado; revisa y vuelve a aplicar.');
      await this.load();
      return;
    }
    this.notice = `No se pudo aplicar: ${message(error)}`;
  }

  render(): void {
    const el = this.containerEl;
    el.empty();
    this.listEl = null;
    this.hiddenEl = null;
    if (!this.client.isConfigured()) {
      el.createEl('p', { text: 'Configura la URL y el token del backend y recarga Recall para elegir tags y límites de estudio.', cls: 'setting-item-description' });
      return;
    }
    el.createEl('h3', { text: 'Estudio' });
    if (this.state === 'loading') {
      el.createEl('p', { text: 'Cargando ajustes de estudio…', cls: 'setting-item-description' });
      return;
    }
    if (this.state === 'error' || !this.loaded || !this.draft || !this.tags) {
      el.createEl('p', { text: `No se pudieron cargar los ajustes de estudio: ${this.error ?? 'respuesta incompleta'}`, cls: 'mod-warning' });
      new Setting(el).addButton(button => button.setButtonText('Reintentar').onClick(() => void this.load()));
      return;
    }
    const loaded = this.loaded, draft = this.draft;
    el.createEl('p', {
      cls: 'setting-item-description',
      text: loaded.source === 'stored'
        ? `Guardados en el servidor (revisión ${loaded.revision}). Se aplican a Obsidian, Android y ChatGPT sin reiniciar.`
        : 'El servidor usa los valores de su entorno (RECALL_TAGS…). Al aplicar un cambio aquí, estos ajustes quedan guardados en el servidor y prevalecen sobre el entorno.',
    });

    this.renderTags(el, draft);

    new Setting(el).setName('Tarjetas nuevas por día').setDesc('0 = sin límite.')
      .addText(text => { text.inputEl.type = 'number'; text.setValue(this.invalid.get('dailyNewLimit') ?? String(draft.dailyNewLimit)).onChange(value => this.setNumber('dailyNewLimit', value)); });
    new Setting(el).setName('Repasos por día').setDesc('0 = sin límite.')
      .addText(text => { text.inputEl.type = 'number'; text.setValue(this.invalid.get('dailyReviewLimit') ?? String(draft.dailyReviewLimit)).onChange(value => this.setNumber('dailyReviewLimit', value)); });
    new Setting(el).setName('Umbral de sanguijuela').setDesc('Fallos (lapsos) a partir de los cuales una tarjeta cuenta como sanguijuela.')
      .addText(text => { text.inputEl.type = 'number'; text.setValue(this.invalid.get('leechThreshold') ?? String(draft.leechThreshold)).onChange(value => this.setNumber('leechThreshold', value)); });
    new Setting(el).setName('Orden aleatorio').setDesc('Baraja la cola de repaso.')
      .addToggle(toggle => toggle.setValue(draft.shuffleReviews).onChange(value => this.setShuffle(value)));

    if (this.notice) el.createEl('p', { text: this.notice, cls: 'mod-warning' });
    if (this.pending) { this.renderConfirmation(el, this.pending.preview); return; }
    const actions = new Setting(el).setDesc(this.busy === 'preview' ? 'Calculando el efecto del cambio…' : 'Primero se muestra qué cambiaría; nada se guarda hasta confirmar.')
      .addButton(button => button.setButtonText('Aplicar').setCta().setDisabled(this.busy !== null).onClick(() => void this.preview()));
    if (loaded.source === 'stored') {
      actions.addButton(button => button.setButtonText('Volver a los valores del entorno').setDisabled(this.busy !== null).onClick(() => void this.preview(true)));
    }
  }

  private renderTags(el: HTMLElement, draft: StudySettings): void {
    const tags = this.tags!;
    new Setting(el).setName('Tags a seguir').setHeading();
    el.createEl('p', {
      cls: 'setting-item-description',
      text: 'Un tag incluye sus subtags (German incluye German/grammar). Las tarjetas que dejes de seguir conservan su historial y vuelven con su estado si recuperas el tag.',
    });
    el.createEl('p', {
      cls: 'recall-tags-summary',
      text: draft.flashcardTags.length
        ? `Seleccionados: ${[...draft.flashcardTags].sort(compareTags).join(', ')}.`
        : 'Ningún tag seleccionado: se estudian todas las notas con tarjetas (las notas sin tags van al mazo «Untagged»).',
    });
    if (tags.tags.length > FILTER_FROM) {
      const input = el.createEl('input', { type: 'search', placeholder: 'Filtrar tags…', value: this.filter, cls: 'recall-tags-filter' });
      input.addEventListener('input', () => { this.filter = input.value; this.renderTagList(draft); });
    }
    if (tags.tags.some(t => t.cards === 0)) {
      // Only the list is redrawn: the filter box keeps focus and the draft is untouched.
      new Setting(el).setName('Mostrar tags sin tarjetas').setDesc('Tags de notas que no contienen tarjetas.')
        .addToggle(toggle => toggle.setValue(this.showEmpty).onChange(value => { this.showEmpty = value; this.renderTagList(draft); }));
    }
    this.hiddenEl = el.createDiv({ cls: 'recall-tags-hidden' });
    this.listEl = el.createDiv({ cls: 'recall-tags-list' });
    this.renderTagList(draft);
    const untagged = tags.untagged;
    if (untagged.notes) {
      el.createEl('p', {
        cls: 'setting-item-description',
        text: `Notas sin tags: ${plural(untagged.notes, 'nota', 'notas')}, ${plural(untagged.cards, 'tarjeta', 'tarjetas')}. Solo se estudian si no seleccionas ningún tag.`,
      });
    }
  }

  /**
   * Tags to list, in tree order. Zero-card tags are hidden unless `showEmpty`, except selected ones
   * (now or on the server, so they can be unticked or ticked back) and ancestors of a listed tag.
   * Only what is drawn depends on this; the selection never does.
   */
  visibleTags(draft: StudySettings, query = this.filter.trim().toLowerCase()): { rows: TagSummary[]; hidden: number } {
    const all = [...this.tags!.tags].sort((a, b) => compareTags(a.tag, b.tag));
    const pinned = new Set([...draft.flashcardTags, ...(this.loaded?.settings.flashcardTags ?? [])]);
    const allowed = (t: TagSummary) => this.showEmpty || t.cards > 0 || pinned.has(t.tag);
    const pick = (q: string) => {
      const shown = new Set<string>();
      for (const t of all) {
        if (!allowed(t) || (q && !t.tag.toLowerCase().includes(q))) continue;
        shown.add(t.tag);
        for (const a of ancestors(t.tag)) shown.add(a);
      }
      return shown;
    };
    const shown = pick(query);
    // Counted over the unfiltered list, so the number does not jump while typing.
    const unfiltered = query ? pick('') : shown;
    const hidden = this.showEmpty ? 0 : all.filter(t => !unfiltered.has(t.tag)).length;
    return { rows: all.filter(t => shown.has(t.tag)), hidden };
  }

  private renderTagList(draft: StudySettings): void {
    const list = this.listEl;
    if (!list) return;
    list.empty();
    const { rows, hidden } = this.visibleTags(draft);
    if (this.hiddenEl) {
      this.hiddenEl.empty();
      if (hidden) this.hiddenEl.createEl('p', { cls: 'setting-item-description', text: `${hidden} ${hidden === 1 ? 'tag sin tarjetas oculto' : 'tags sin tarjetas ocultos'}.` });
    }
    if (!this.tags!.tags.length) { list.createEl('p', { text: 'Las notas publicadas no tienen tags.', cls: 'setting-item-description' }); return; }
    if (!rows.length) {
      list.createEl('p', {
        cls: 'setting-item-description',
        text: this.filter.trim() ? 'Ningún tag coincide con el filtro.' : 'Ningún tag tiene tarjetas. Activa «Mostrar tags sin tarjetas» para verlos.',
      });
      return;
    }
    for (const entry of rows) {
      const selected = draft.flashcardTags.includes(entry.tag);
      const coveredBy = selected ? undefined : coveringTag(entry.tag, draft.flashcardTags);
      const state = selected ? ' recall-tag-selected' : coveredBy ? ' recall-tag-covered' : '';
      const row = list.createDiv({ cls: `recall-tag-row${state}` });
      row.style.paddingLeft = `${(entry.tag.split('/').length - 1) * 16}px`;
      const label = row.createEl('label');
      const box = label.createEl('input', { type: 'checkbox' });
      box.checked = selected || !!coveredBy;
      // A sub-tag of a selected tag is already followed; unselecting it alone is not possible.
      box.disabled = !!coveredBy;
      box.addEventListener('change', () => this.setTag(entry.tag, box.checked));
      label.createSpan({ text: ` ${entry.tag}`, cls: 'recall-tag-name' });
      label.createSpan({
        cls: 'recall-tag-counts setting-item-description',
        text: ` · ${plural(entry.notes, 'nota', 'notas')}, ${plural(entry.cards, 'tarjeta', 'tarjetas')}${coveredBy ? ` · incluido por ${coveredBy}` : ''}`,
      });
    }
  }

  private renderConfirmation(el: HTMLElement, preview: SettingsUpdateResult): void {
    const box = el.createDiv({ cls: 'recall-settings-confirm' });
    box.createEl('h4', { text: 'Confirmar cambios de estudio' });
    const impact = preview.impact;
    const lines: string[] = [];
    if (impact.notes) lines.push(`Se reindexarán ${plural(impact.notes, 'nota publicada', 'notas publicadas')}.`);
    lines.push(`Tarjetas: ${impact.cardsBefore} → ${impact.cardsAfter} (+${impact.cardsAdded}, −${impact.cardsRemoved}).`);
    lines.push(`Mazos con tarjetas: ${impact.decksBefore} → ${impact.decksAfter}.`);
    if (impact.cardsRemoved) lines.push('Las tarjetas quitadas dejan de aparecer en los repasos; su historial se conserva y vuelven con su estado si recuperas el tag.');
    const s = preview.settings;
    lines.push(`Tags: ${s.flashcardTags.length ? s.flashcardTags.join(', ') : 'todas las notas con tarjetas'}. Nuevas/día: ${s.dailyNewLimit || 'sin límite'}. Repasos/día: ${s.dailyReviewLimit || 'sin límite'}. Sanguijuela: ${s.leechThreshold}. Orden aleatorio: ${s.shuffleReviews ? 'sí' : 'no'}.`);
    if (preview.source === 'environment') lines.push('Se volverá a los valores del entorno del servidor.');
    for (const line of lines) box.createEl('p', { text: line });
    new Setting(box).setDesc(this.busy === 'apply' ? 'Aplicando…' : '')
      .addButton(button => button.setButtonText('Confirmar').setCta().setDisabled(this.busy !== null).onClick(() => void this.confirm()))
      .addButton(button => button.setButtonText('Cancelar').setDisabled(this.busy !== null).onClick(() => this.cancel()));
  }
}
