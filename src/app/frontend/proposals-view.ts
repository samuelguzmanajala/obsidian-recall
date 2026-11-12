import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import type { CardProposal, StudyClient } from '@app/backend/study-client';
import {
  type CardDraft, type DeckInfo, type ProposalInbox, ProposalError, deckPlacement, draftOf, draftProblem, inboxNotePath, resolveDeck,
} from '@app/backend/proposal-inbox';
import { VIEW_TYPE_PROPOSALS } from './constants';
import { LiveRefresh } from './live-refresh';
import { renderNotConfigured } from './not-configured';

export interface ProposalsViewOptions {
  /** Whether this device publishes notes (otherwise written cards reach the backend from another device). */
  publishesNotes(): boolean;
  /** Opens a vault note, if it exists. */
  openNote(path: string): void;
  notify?(text: string): void;
}

const DIRECTION_LABELS: Record<CardDraft['directionality'], string> = {
  bidirectional: 'Both directions (:::)',
  unidirectional: 'One direction (::)',
};

/**
 * Card proposals from ChatGPT (MCP), pending the owner's decision. Accept writes the card into the
 * deck's inbox note and then accepts it on the backend; Dismiss only tells the backend.
 * Nothing is written to the vault without a click on Accept.
 */
export class ProposalsView extends ItemView {
  proposals: CardProposal[] | null = null;
  info: DeckInfo = { tags: null, settings: null };
  error: string | null = null;
  /** Proposal being accepted or dismissed. */
  busy: number | null = null;
  /** Proposal whose sides are being edited, with the edited values. */
  editing: { id: number; draft: CardDraft } | null = null;
  private lastHash = '';
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private live = new LiveRefresh(current => this.update(current));
  private readonly notify: (text: string) => void;

  constructor(leaf: WorkspaceLeaf, private readonly client: StudyClient, private readonly inbox: ProposalInbox, private readonly options: ProposalsViewOptions) {
    super(leaf);
    this.notify = options.notify ?? (text => { new Notice(text, 10000); });
  }

  getViewType(): string { return VIEW_TYPE_PROPOSALS; }
  getDisplayText(): string { return 'Card proposals'; }
  getIcon(): string { return 'inbox'; }

  async onOpen(): Promise<void> {
    await this.refresh();
    if (this.live.stopped || !this.client.isConfigured()) return;
    const refreshVisible = () => {
      if (!this.contentEl.ownerDocument.hidden && this.contentEl.getClientRects().length) void this.refresh();
    };
    this.refreshTimer = setInterval(refreshVisible, 10_000);
    this.registerDomEvent(this.contentEl.ownerDocument, 'visibilitychange', refreshVisible);
    this.registerDomEvent(this.contentEl.ownerDocument.defaultView!, 'focus', refreshVisible);
    this.registerEvent(this.app.workspace.on('active-leaf-change', refreshVisible));
    this.register(this.client.onChange(refreshVisible));
  }

  async onClose(): Promise<void> {
    this.live.close();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  refresh(): Promise<void> { return this.live.request(); }

  private async update(isCurrent: () => boolean): Promise<void> {
    if (!this.client.isConfigured()) { this.show(); return; }
    try {
      const [proposals, tags, settings] = await Promise.all([
        this.client.getProposals(),
        // Only used to spell decks like existing tags and to warn about unfollowed ones.
        this.client.getTags().catch(() => null),
        this.client.getStudySettings().then(state => state.settings).catch(() => null),
      ]);
      if (!isCurrent()) return;
      this.inbox.forget(new Set(proposals.map(p => p.id)));
      this.proposals = proposals;
      this.info = { tags, settings };
      this.error = null;
    } catch (error) {
      if (!isCurrent()) return;
      this.error = (error as Error).message;
    }
    this.show();
  }

  /** Rebuilds the DOM only when what it shows changed, and never under an open edit form. */
  show(force = false): void {
    const hash = JSON.stringify([
      this.client.isConfigured(), this.proposals, this.info, this.error, this.busy, this.editing?.id ?? null,
      this.proposals?.map(p => this.inbox.pendingWrite(p.id)), this.inbox.inboxFolder, this.options.publishesNotes(),
    ]);
    if (!force && (hash === this.lastHash || this.editing)) return;
    this.lastHash = hash;
    const scrollTop = this.contentEl.scrollTop;
    this.renderContent();
    this.contentEl.scrollTop = scrollTop;
  }

  private renderContent(): void {
    const el = this.contentEl;
    el.empty();
    el.addClass('recall-proposals');
    if (!this.client.isConfigured()) { renderNotConfigured(el); return; }

    el.createDiv({ cls: 'recall-header' }).createSpan({ text: 'Card proposals', cls: 'recall-title' });
    if (this.error) {
      const warning = el.createDiv({ cls: 'recall-connection-error' });
      warning.setAttribute('role', 'status');
      warning.createEl('p', { text: this.proposals ? `Recall is offline; the list may be outdated. ${this.error}` : `Cannot load card proposals: ${this.error}` });
      warning.createEl('button', { text: 'Retry connection' }).addEventListener('click', () => void this.refresh());
    }
    if (!this.proposals) {
      if (!this.error) el.createDiv({ text: 'Loading card proposals…', cls: 'recall-empty' });
      return;
    }
    el.createEl('p', {
      cls: 'recall-proposals-help',
      text: `Accepting appends the card to a note in “${this.inbox.inboxFolder}” (one note per deck); publishing that note creates the card. Nothing else in the vault is changed.`,
    });
    if (!this.options.publishesNotes()) {
      el.createEl('p', {
        cls: 'recall-proposals-warning',
        text: 'This device does not publish notes: accepted cards are written to the vault, and become cards when a device that publishes notes sees them.',
      });
    }
    if (!this.proposals.length) {
      el.createDiv({ text: 'No pending card proposals. Cards that ChatGPT proposes during a session appear here.', cls: 'recall-empty' });
      return;
    }
    const list = el.createDiv({ cls: 'recall-proposal-list' });
    for (const proposal of this.proposals) this.renderProposal(list, proposal);
  }

  private renderProposal(parent: HTMLElement, proposal: CardProposal): void {
    const row = parent.createDiv({ cls: 'recall-proposal' });
    const written = this.inbox.pendingWrite(proposal.id);
    const busy = this.busy !== null;
    if (this.editing?.id === proposal.id && !written) { this.renderEditor(row, proposal, this.editing.draft); return; }

    const draft = draftOf(proposal, this.info);
    const card = row.createDiv({ cls: 'recall-proposal-card' });
    card.createSpan({ text: proposal.sideA, cls: 'recall-proposal-side' });
    card.createSpan({ text: proposal.directionality === 'bidirectional' ? ' ⇄ ' : ' → ', cls: 'recall-proposal-arrow' });
    card.createSpan({ text: proposal.sideB, cls: 'recall-proposal-side' });

    const meta = row.createDiv({ cls: 'recall-proposal-meta' });
    meta.createSpan({ text: DIRECTION_LABELS[proposal.directionality] });
    meta.createSpan({ text: ` · Deck: ${draft.deck ?? 'none'}` });
    meta.createSpan({ text: ` · Proposed ${new Date(proposal.createdAt).toLocaleString()}` });
    if (proposal.context) row.createDiv({ text: proposal.context, cls: 'recall-proposal-context' });

    if (written) {
      row.createDiv({ cls: 'recall-proposal-target', text: `Written to ${written.notePath}; waiting for the backend to confirm.` });
    } else {
      row.createDiv({ cls: 'recall-proposal-target', text: `Will be added to ${inboxNotePath(this.inbox.inboxFolder, draft.deck)}` });
      for (const text of this.placementWarnings(draft.deck)) row.createDiv({ text, cls: 'recall-proposals-warning' });
    }

    const actions = row.createDiv({ cls: 'recall-proposal-actions' });
    const accept = actions.createEl('button', { text: written ? 'Confirm' : 'Accept', cls: 'mod-cta' });
    accept.disabled = busy;
    accept.addEventListener('click', () => void this.accept(proposal, draft));
    if (!written) {
      const edit = actions.createEl('button', { text: 'Edit' });
      edit.disabled = busy;
      edit.addEventListener('click', () => { this.editing = { id: proposal.id, draft: { ...draft } }; this.show(true); });
    }
    const dismiss = actions.createEl('button', { text: 'Dismiss' });
    dismiss.disabled = busy;
    dismiss.addEventListener('click', () => void this.dismiss(proposal));
    if (written) {
      const open = actions.createEl('button', { text: 'Open note' });
      open.addEventListener('click', () => this.options.openNote(written.notePath));
    }
    if (this.busy === proposal.id) actions.createSpan({ text: 'Working…', cls: 'recall-proposal-busy' });
  }

  private placementWarnings(deck: string | null): string[] {
    const placement = deckPlacement(deck, this.info);
    const out: string[] = [];
    if (deck === null) out.push('No deck suggested: the card goes to the Untagged deck. Edit to choose one.');
    else if (placement.exists === false) out.push(`New deck: no note has the tag ${deck} yet.`);
    if (placement.followed === false) {
      out.push(deck === null
        ? 'Notes without tags are not studied while you follow tags. Edit to choose a followed deck.'
        : `The tag ${deck} is not followed: the card will not be studied until you follow it (Settings → Recall).`);
    }
    return out;
  }

  private renderEditor(row: HTMLElement, proposal: CardProposal, draft: CardDraft): void {
    row.addClass('recall-proposal-editing');
    const field = (label: string, value: string, set: (value: string) => void) => {
      const wrap = row.createEl('label', { cls: 'recall-proposal-field' });
      wrap.createSpan({ text: label });
      const input = wrap.createEl('input', { type: 'text', value });
      input.addEventListener('input', () => set(input.value));
      return input;
    };
    field('Side A', draft.sideA, value => { draft.sideA = value; });
    field('Side B', draft.sideB, value => { draft.sideB = value; });
    field('Deck (tag, empty for none)', draft.deck ?? '', value => { draft.deck = value.trim().replace(/^#/, '') || null; });
    const wrap = row.createEl('label', { cls: 'recall-proposal-field' });
    wrap.createSpan({ text: 'Direction' });
    const select = wrap.createEl('select');
    for (const value of ['bidirectional', 'unidirectional'] as const) {
      const option = select.createEl('option', { text: DIRECTION_LABELS[value], value });
      option.selected = value === draft.directionality;
    }
    select.addEventListener('change', () => { draft.directionality = select.value as CardDraft['directionality']; });
    if (proposal.context) row.createDiv({ text: proposal.context, cls: 'recall-proposal-context' });

    const actions = row.createDiv({ cls: 'recall-proposal-actions' });
    const accept = actions.createEl('button', { text: 'Accept', cls: 'mod-cta' });
    accept.disabled = this.busy !== null;
    accept.addEventListener('click', () => {
      const edited = { ...draft, sideA: draft.sideA.trim(), sideB: draft.sideB.trim(), deck: resolveDeck(draft.deck, this.info) };
      const problem = draftProblem(edited);
      if (problem) { this.notify(`Recall: ${problem}`); return; }
      void this.accept(proposal, edited);
    });
    const cancel = actions.createEl('button', { text: 'Cancel' });
    cancel.disabled = this.busy !== null;
    cancel.addEventListener('click', () => { this.editing = null; this.show(true); });
  }

  async accept(proposal: CardProposal, draft: CardDraft): Promise<void> {
    if (this.busy !== null) return;
    await this.decide(proposal, async () => {
      const { notePath, appended } = await this.inbox.accept(proposal, draft);
      this.editing = null;
      this.notify(appended ? `Recall: card added to ${notePath}.` : `Recall: the card was already in ${notePath}; proposal accepted.`);
    });
  }

  async dismiss(proposal: CardProposal): Promise<void> {
    if (this.busy !== null) return;
    await this.decide(proposal, async () => {
      const { leftIn } = await this.inbox.dismiss(proposal);
      if (this.editing?.id === proposal.id) this.editing = null;
      if (leftIn) this.notify(`Recall: proposal dismissed. The card already written to ${leftIn} stays there; remove it if you do not want it.`);
    });
  }

  private async decide(proposal: CardProposal, work: () => Promise<void>): Promise<void> {
    this.busy = proposal.id;
    this.live.invalidate(); // A list fetched before the decision must not overwrite it.
    this.show(true);
    try {
      await work();
    } catch (error) {
      this.notify(`Recall: ${(error as Error).message}`);
      if (error instanceof ProposalError && error.gone && this.editing?.id === proposal.id) this.editing = null;
    } finally {
      this.busy = null;
    }
    this.show(true);
    await this.refresh();
  }
}
