import { Notice, Setting, type ButtonComponent } from 'obsidian';
import type { SettingsUpdate, SettingsUpdateResult, StudyClient, StudySettings, StudySettingsState, TagListing, TagSummary } from './study-client';

export type StudySettingsClient = Pick<StudyClient, 'isConfigured' | 'getStudySettings' | 'getTags' | 'updateStudySettings'> & {
  /** Asks the open views to refresh. */
  notifyChanged(): void;
};

/** Show the filter box above this many tags. */
const FILTER_FROM = 12;
/** Tag changes listed by name in the pending bar; the rest are counted. */
const BAR_TAGS = 8;

type NumberKey = 'dailyNewLimit' | 'dailyReviewLimit' | 'leechThreshold';
const FIELD_LABEL: Record<NumberKey | 'shuffleReviews', string> = {
  dailyNewLimit: 'nuevas/día', dailyReviewLimit: 'repasos/día', leechThreshold: 'umbral de leech', shuffleReviews: 'orden aleatorio',
};

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
/** Strict ancestors of a tag path: "a/b/c" → ["a", "a/b"]. */
function ancestors(tag: string): string[] {
  const parts = tag.split('/');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}
/** Case-insensitive, segment by segment, so a parent is always followed by its own sub-tags. */
function compareTags(a: string, b: string): number {
  const x = a.toLowerCase().split('/'), y = b.toLowerCase().split('/');
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const c = x[i].localeCompare(y[i]);
    if (c) return c;
  }
  return x.length - y.length || (a < b ? -1 : a > b ? 1 : 0);
}
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
function limit(n: number): string {
  return n ? String(n) : 'sin límite';
}
function tagList(tags: readonly string[]): string {
  return tags.length ? [...tags].sort(compareTags).join(', ') : 'todas las notas con tarjetas';
}

/**
 * "Estudio" section of the settings tab: tags to follow, daily limits, leech threshold and
 * shuffle, stored on the backend. Loaded when the tab opens. Edits are a draft: a sticky bar at
 * the top lists them with "Aplicar…" (dry run, then a confirmation showing the impact) and
 * "Descartar". While a confirmation is on screen the form is locked, so what is confirmed is
 * exactly what was previewed. Never throws: failures are shown in the section.
 */
export class StudySettingsSection {
  state: 'loading' | 'error' | 'loaded' = 'loading';
  error: string | null = null;
  loaded: StudySettingsState | null = null;
  tags: TagListing | null = null;
  /** Edited values, saved only through "Aplicar…" + "Confirmar". */
  draft: StudySettings | null = null;
  /** Text typed in the numeric fields that is not a valid number (field → text). */
  invalid = new Map<NumberKey, string>();
  filter = '';
  /** Also list tags without cards (selected tags are always listed). */
  showEmpty = false;
  /** Dry-run answer awaiting confirmation, with the command that produced it. */
  pending: { command: SettingsUpdate; preview: SettingsUpdateResult } | null = null;
  busy: 'preview' | 'apply' | null = null;
  notice: string | null = null;
  private barEl: HTMLElement | null = null;
  private summaryEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private confirmButton: ButtonComponent | null = null;
  private listScroll: number | undefined;

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

  /** The form differs from the loaded server state (including numbers that are not valid yet). */
  isDirty(): boolean {
    return this.invalid.size > 0 || Object.keys(this.changes()).length > 0;
  }

  /** Short descriptions of every pending change, in form order ("+historia", "nuevas/día 40 → 30"). */
  pendingChanges(): string[] {
    if (!this.loaded || !this.draft) return [];
    const before = this.loaded.settings, after = this.draft;
    const added = after.flashcardTags.filter(t => !before.flashcardTags.includes(t)).sort(compareTags);
    const removed = before.flashcardTags.filter(t => !after.flashcardTags.includes(t)).sort(compareTags);
    const out = [...added.map(t => `+${t}`), ...removed.map(t => `−${t}`)];
    for (const key of ['dailyNewLimit', 'dailyReviewLimit', 'leechThreshold'] as const) {
      const bad = this.invalid.get(key);
      if (bad !== undefined) out.push(`${FIELD_LABEL[key]}: «${bad}» no es válido`);
      else if (before[key] !== after[key]) {
        const show = key === 'leechThreshold' ? String : limit;
        out.push(`${FIELD_LABEL[key]} ${show(before[key])} → ${show(after[key])}`);
      }
    }
    if (before.shuffleReviews !== after.shuffleReviews) {
      out.push(`${FIELD_LABEL.shuffleReviews} ${before.shuffleReviews ? 'sí' : 'no'} → ${after.shuffleReviews ? 'sí' : 'no'}`);
    }
    return out;
  }

  /** A dry run is running or its confirmation is on screen: edits are refused. */
  isLocked(): boolean {
    return this.pending !== null || this.busy !== null;
  }

  setTag(tag: string, on: boolean): void {
    if (!this.draft || this.isLocked()) return;
    const tags = this.draft.flashcardTags.filter(t => t !== tag);
    if (on) tags.push(tag);
    this.draft.flashcardTags = tags;
    this.notice = null;
    // Partial update: keeps the scroll position of the list and the order of its rows.
    this.renderBar();
    this.renderSummary();
    this.renderTagList();
  }

  setNumber(key: NumberKey, text: string): void {
    if (!this.draft || this.isLocked()) return;
    this.notice = null;
    const value = Number(text.trim());
    if (text.trim() === '' || !Number.isSafeInteger(value) || value < 0) this.invalid.set(key, text);
    else { this.invalid.delete(key); this.draft[key] = value; }
    this.renderBar(); // only the bar: the field keeps its focus
  }

  setShuffle(on: boolean): void {
    if (!this.draft || this.isLocked()) return;
    this.notice = null;
    this.draft.shuffleReviews = on;
    this.renderBar();
  }

  /** "Descartar": back to the values loaded from the server. */
  discard(): void {
    if (!this.loaded || this.isLocked()) return;
    this.draft = { ...this.loaded.settings, flashcardTags: [...this.loaded.settings.flashcardTags] };
    this.invalid.clear();
    this.notice = null;
    this.render();
  }

  /** "Aplicar…": dry run, then show what would change. `reset`: back to the server's environment values. */
  async preview(reset = false): Promise<void> {
    if (!this.loaded || this.isLocked()) return;
    if (!reset && this.invalid.size) { this.notice = 'Corrige los campos numéricos: deben ser enteros ≥ 0.'; this.renderBar(); return; }
    const settings = this.changes();
    if (!reset && !Object.keys(settings).length) { this.notice = 'No hay cambios que aplicar.'; this.renderBar(); return; }
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
    if (this.pending) this.revealConfirmation();
  }

  /** The confirmation lives in the sticky bar; make sure it is on screen and "Confirmar" has the focus. */
  private revealConfirmation(): void {
    this.barEl?.scrollIntoView?.({ block: 'nearest' });
    this.confirmButton?.buttonEl?.focus?.();
  }

  cancel(): void {
    if (this.busy) return;
    this.pending = null;
    this.render();
  }

  /** Sends the command that was previewed (same operationId: a retry after a lost answer is safe). */
  async confirm(): Promise<void> {
    if (!this.pending || this.busy) return;
    this.busy = 'apply';
    this.notice = null;
    this.render();
    let result: SettingsUpdateResult;
    try {
      result = await this.client.updateStudySettings(this.pending.command);
    } catch (error) {
      this.busy = null;
      await this.failed(error);
      this.render();
      return;
    }
    this.pending = null;
    this.busy = null;
    const tags = `Tags: ${tagList(result.settings.flashcardTags)}.`;
    this.notify(result.source === 'environment'
      ? `Recall: ajustes de estudio restablecidos a los valores del entorno del servidor. ${tags}`
      : `Recall: ajustes de estudio guardados. ${tags}`);
    this.client.notifyChanged();
    await this.load();
  }

  /**
   * The settings tab is being closed: unapplied edits are dropped (never saved implicitly), so
   * say so. A confirmation already being sent finishes on its own and reports its result.
   */
  leave(): void {
    if (this.busy === 'apply' || this.state !== 'loaded') return;
    if (this.isDirty()) this.notify('Recall: había cambios de estudio sin aplicar; no se han guardado.');
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
    // A full render rebuilds the tag list: keep where it was scrolled.
    this.listScroll = this.listEl?.scrollTop;
    el.empty();
    this.barEl = this.summaryEl = this.listEl = null;
    this.confirmButton = null;
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
    const loaded = this.loaded, draft = this.draft, locked = this.isLocked();
    // Sticky: pending changes, the confirmation and notices stay visible while the pane scrolls.
    this.barEl = el.createDiv({ cls: 'recall-study-sticky' });
    this.renderBar();
    el.createEl('p', {
      cls: 'setting-item-description recall-study-status',
      text: loaded.source === 'stored'
        ? `Guardados en el servidor (revisión ${loaded.revision}). Se aplican a Obsidian, Android y ChatGPT sin reiniciar.`
        : 'El servidor usa los valores de su entorno (RECALL_TAGS…). Al aplicar un cambio aquí, estos ajustes quedan guardados en el servidor y prevalecen sobre el entorno.',
    });

    this.renderTags(el, locked);

    new Setting(el).setName('Tarjetas nuevas por día').setDesc('0 = sin límite.')
      .addText(text => { text.inputEl.type = 'number'; text.setValue(this.invalid.get('dailyNewLimit') ?? String(draft.dailyNewLimit)).setDisabled(locked).onChange(value => this.setNumber('dailyNewLimit', value)); });
    new Setting(el).setName('Repasos por día').setDesc('0 = sin límite.')
      .addText(text => { text.inputEl.type = 'number'; text.setValue(this.invalid.get('dailyReviewLimit') ?? String(draft.dailyReviewLimit)).setDisabled(locked).onChange(value => this.setNumber('dailyReviewLimit', value)); });
    new Setting(el).setName('Umbral de leech').setDesc('Fallos a partir de los cuales una tarjeta se marca como leech.')
      .addText(text => { text.inputEl.type = 'number'; text.setValue(this.invalid.get('leechThreshold') ?? String(draft.leechThreshold)).setDisabled(locked).onChange(value => this.setNumber('leechThreshold', value)); });
    new Setting(el).setName('Orden aleatorio').setDesc('Baraja la cola de repaso.')
      .addToggle(toggle => toggle.setValue(draft.shuffleReviews).setDisabled(locked).onChange(value => this.setShuffle(value)));

    if (loaded.source === 'stored') {
      new Setting(el).setDesc('Descarta los ajustes guardados y vuelve a los del entorno del servidor. Primero se muestra qué cambiaría.')
        .addButton(button => button.setButtonText('Volver a los valores del entorno').setDisabled(locked).onClick(() => void this.preview(true)));
    }
  }

  /** Sticky area: the confirmation, the dry run in progress, or the pending changes; plus the notice. */
  private renderBar(): void {
    const bar = this.barEl;
    if (!bar) return;
    bar.empty();
    this.confirmButton = null;
    if (this.pending) this.renderConfirmation(bar, this.pending.preview);
    else if (this.busy === 'preview') {
      bar.createDiv({ cls: 'recall-study-pending is-busy' }).createEl('p', { cls: 'recall-study-pending-title', text: 'Calculando el efecto del cambio…' });
    } else if (this.isDirty()) {
      const items = this.pendingChanges();
      const box = bar.createDiv({ cls: 'recall-study-pending' });
      const tagItems = items.filter(i => i.startsWith('+') || i.startsWith('−'));
      const shown = tagItems.length > BAR_TAGS ? [...tagItems.slice(0, BAR_TAGS), `y ${tagItems.length - BAR_TAGS} tags más`] : tagItems;
      const parts = [shown.join(', '), ...items.filter(i => !tagItems.includes(i))].filter(Boolean);
      box.createEl('p', { cls: 'recall-study-pending-title', text: `Cambios sin aplicar (${items.length}): ${parts.join(' · ')}` });
      box.createEl('p', { cls: 'recall-study-pending-hint setting-item-description', text: 'Nada se guarda hasta que pulses «Aplicar…» y confirmes. Si cierras los ajustes, se descartan.' });
      new Setting(box)
        .addButton(button => button.setButtonText('Aplicar…').setCta().onClick(() => void this.preview()))
        .addButton(button => button.setButtonText('Descartar').onClick(() => this.discard()));
    }
    if (this.notice) bar.createEl('p', { text: this.notice, cls: 'mod-warning recall-study-notice' });
  }

  private renderSummary(): void {
    const el = this.summaryEl, draft = this.draft;
    if (!el || !draft) return;
    el.empty();
    el.createSpan({
      text: draft.flashcardTags.length
        ? `Seleccionados: ${[...draft.flashcardTags].sort(compareTags).join(', ')}.`
        : 'Ningún tag seleccionado: se estudian todas las notas con tarjetas (las notas sin tags van al mazo «Untagged»).',
    });
  }

  private renderTags(el: HTMLElement, locked: boolean): void {
    const tags = this.tags!;
    new Setting(el).setName('Tags a seguir').setHeading();
    el.createEl('p', {
      cls: 'setting-item-description',
      text: 'Los tags que sigas aparecen como mazos en Obsidian y en la app de Android después de aplicar (en la siguiente actualización).',
    });
    el.createEl('p', {
      cls: 'setting-item-description',
      text: 'Un tag incluye sus subtags (German incluye German/grammar). Las tarjetas que dejes de seguir conservan su historial y vuelven con su estado si recuperas el tag.',
    });
    this.summaryEl = el.createEl('p', { cls: 'recall-tags-summary' });
    this.renderSummary();
    if (tags.tags.length > FILTER_FROM) {
      const input = el.createEl('input', { type: 'search', placeholder: 'Filtrar tags…', value: this.filter, cls: 'recall-tags-filter' });
      input.addEventListener('input', () => { this.filter = input.value; this.renderTagList(); });
    }
    const empty = tags.tags.filter(t => t.cards === 0).length;
    if (empty) {
      new Setting(el).setName(`Mostrar tags sin tarjetas (${empty})`).setDesc('Los tags seleccionados se muestran siempre.')
        .addToggle(toggle => toggle.setValue(this.showEmpty).onChange(value => { this.showEmpty = value; this.renderTagList(); }));
    }
    this.listEl = el.createDiv({ cls: locked ? 'recall-tags-list is-locked' : 'recall-tags-list' });
    this.renderTagList();
    const untagged = tags.untagged;
    if (untagged.notes) {
      el.createEl('p', {
        cls: 'setting-item-description',
        text: `Notas sin tags: ${plural(untagged.notes, 'nota', 'notas')}, ${plural(untagged.cards, 'tarjeta', 'tarjetas')}. Solo se estudian si no seleccionas ningún tag.`,
      });
    }
  }

  /**
   * Rows to list, in two groups: tags the server follows now (selected and their sub-tags), then
   * the rest; each alphabetical (case-insensitive), parents before their sub-tags. Tags without
   * cards are hidden unless `showEmpty` or selected; the filter keeps the parents of its matches.
   * The groups come from the server state, so ticking a box does not move rows around.
   */
  visibleTags(): { followed: TagSummary[]; others: TagSummary[] } {
    if (!this.tags || !this.loaded || !this.draft) return { followed: [], others: [] };
    const all = this.tags.tags;
    const byTag = new Map(all.map(t => [t.tag, t]));
    const saved = this.loaded.settings.flashcardTags;
    const chosen = new Set([...saved, ...this.draft.flashcardTags]);
    const query = this.filter.trim().toLowerCase();
    const shown = new Set<string>();
    for (const t of all) {
      if (!this.showEmpty && t.cards === 0 && !chosen.has(t.tag)) continue;
      if (query && !t.tag.toLowerCase().includes(query)) continue;
      shown.add(t.tag);
      for (const parent of ancestors(t.tag)) if (byTag.has(parent)) shown.add(parent);
    }
    const rows = [...shown].sort(compareTags).map(tag => byTag.get(tag)!);
    const isFollowed = (tag: string) => saved.includes(tag) || !!coveringTag(tag, saved);
    return { followed: rows.filter(t => isFollowed(t.tag)), others: rows.filter(t => !isFollowed(t.tag)) };
  }

  private renderTagList(): void {
    const list = this.listEl, draft = this.draft;
    if (!list || !draft || !this.tags) return;
    const scroll = this.listScroll ?? list.scrollTop;
    this.listScroll = undefined;
    list.empty();
    const locked = this.isLocked();
    if (!this.tags.tags.length) { list.createEl('p', { text: 'Las notas publicadas no tienen tags.', cls: 'setting-item-description' }); return; }
    const { followed, others } = this.visibleTags();
    if (!followed.length && !others.length) {
      list.createEl('p', {
        cls: 'setting-item-description',
        text: this.filter.trim() ? 'Ningún tag coincide con el filtro.' : 'Ningún tag tiene tarjetas. Activa «Mostrar tags sin tarjetas» para verlos.',
      });
      return;
    }
    const group = (title: string, rows: TagSummary[]) => {
      if (!rows.length) return;
      if (followed.length && others.length) list.createDiv({ cls: 'recall-tags-group', text: title });
      const inGroup = new Set(rows.map(r => r.tag));
      for (const entry of rows) this.renderTagRow(list, entry, ancestors(entry.tag).filter(a => inGroup.has(a)).length, draft, locked);
    };
    group('Seguidos ahora', followed);
    group('Otros tags', others);
    list.scrollTop = scroll;
  }

  private renderTagRow(list: HTMLElement, entry: TagSummary, depth: number, draft: StudySettings, locked: boolean): void {
    const selected = draft.flashcardTags.includes(entry.tag);
    const coveredBy = coveringTag(entry.tag, draft.flashcardTags);
    const state = selected ? ' is-selected' : coveredBy ? ' is-covered' : '';
    const row = list.createDiv({ cls: `recall-tag-row${state}` });
    row.style.paddingLeft = `${depth * 16}px`;
    const label = row.createEl('label');
    const box = label.createEl('input', { type: 'checkbox' });
    box.checked = selected;
    // Followed through its parent: not a choice of its own, so not a plain tick, and not editable.
    box.indeterminate = !selected && !!coveredBy;
    box.disabled = locked || (!!coveredBy && !selected);
    box.addEventListener('change', () => this.setTag(entry.tag, box.checked));
    label.createSpan({ text: ` ${entry.tag}`, cls: 'recall-tag-name' });
    label.createSpan({
      cls: 'recall-tag-counts setting-item-description',
      text: ` · ${plural(entry.notes, 'nota', 'notas')}, ${plural(entry.cards, 'tarjeta', 'tarjetas')}${coveredBy ? ` · incluido por ${coveredBy}` : ''}`,
    });
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
    lines.push(`Tags: ${tagList(s.flashcardTags)}. Nuevas/día: ${limit(s.dailyNewLimit)}. Repasos/día: ${limit(s.dailyReviewLimit)}. Umbral de leech: ${s.leechThreshold}. Orden aleatorio: ${s.shuffleReviews ? 'sí' : 'no'}.`);
    if (preview.source === 'environment') lines.push('Se volverá a los valores del entorno del servidor.');
    for (const line of lines) box.createEl('p', { text: line });
    new Setting(box).setDesc(this.busy === 'apply' ? 'Aplicando…' : 'El formulario queda bloqueado hasta que confirmes o canceles.')
      .addButton(button => { this.confirmButton = button; button.setButtonText('Confirmar').setCta().setDisabled(this.busy !== null).onClick(() => void this.confirm()); })
      .addButton(button => button.setButtonText('Cancelar').setDisabled(this.busy !== null).onClick(() => this.cancel()));
  }
}
