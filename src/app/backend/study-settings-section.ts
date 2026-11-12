import { Notice, Setting } from 'obsidian';
import type { SettingsUpdate, SettingsUpdateResult, StudyClient, StudySettings, StudySettingsState, TagListing } from './study-client';

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
  /** Dry-run answer awaiting confirmation, with the command that produced it. */
  pending: { command: SettingsUpdate; preview: SettingsUpdateResult } | null = null;
  busy: 'preview' | 'apply' | null = null;
  notice: string | null = null;
  private listEl: HTMLElement | null = null;

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
        ? `Seleccionados: ${[...draft.flashcardTags].sort().join(', ')}.`
        : 'Ningún tag seleccionado: se estudian todas las notas con tarjetas (las notas sin tags van al mazo «Untagged»).',
    });
    if (tags.tags.length > FILTER_FROM) {
      const input = el.createEl('input', { type: 'search', placeholder: 'Filtrar tags…', value: this.filter, cls: 'recall-tags-filter' });
      input.addEventListener('input', () => { this.filter = input.value; this.renderTagList(draft); });
    }
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

  private renderTagList(draft: StudySettings): void {
    const list = this.listEl;
    if (!list) return;
    list.empty();
    const query = this.filter.trim().toLowerCase();
    const rows = this.tags!.tags.filter(t => !query || t.tag.toLowerCase().includes(query));
    if (!this.tags!.tags.length) { list.createEl('p', { text: 'Las notas publicadas no tienen tags.', cls: 'setting-item-description' }); return; }
    if (!rows.length) { list.createEl('p', { text: 'Ningún tag coincide con el filtro.', cls: 'setting-item-description' }); return; }
    for (const entry of rows) {
      const selected = draft.flashcardTags.includes(entry.tag);
      const coveredBy = coveringTag(entry.tag, draft.flashcardTags);
      const row = list.createDiv({ cls: 'recall-tag-row' });
      row.style.paddingLeft = `${(entry.tag.split('/').length - 1) * 16}px`;
      const label = row.createEl('label');
      const box = label.createEl('input', { type: 'checkbox' });
      box.checked = selected || !!coveredBy;
      // A sub-tag of a selected tag is already followed; unselecting it alone is not possible.
      box.disabled = !!coveredBy && !selected;
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
