import { createHash, randomBytes } from 'node:crypto';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ServerAudio } from './configure-audio';
import { fileStorage } from './configure-audio';
import { audioSource, audioTarget, type AudioTarget } from './audio-plan';
import type { AudioSide, RecallService } from '../service';
import { costUsd, estimateInputTokens, estimateSeconds, nextPrice, priceOn, type TokenPrice } from './tts-prices';
import { TtsDailyQuotaError } from '../../context/shared/domain/tts-client';
import { TtsBatchRejectedError, type TtsBatchClient, type TtsBatchConfig } from '../../context/shared/domain/tts-batch-client';
import { wavSeconds } from '../../context/shared/infrastructure/gemini-tts-client';

export const STATE_FILE = 'pregenerate-state.json';
/** A text that failed this many times (in different batches) is reported and no longer submitted. */
export const MAX_ATTEMPTS = 2;
const MIN_BATCH = 10;

export interface PregenerateOptions {
  apply: boolean;
  mode: 'batch' | 'interactive';
  limit?: number;
  maxUsd?: number;
  batchSize: number;
  concurrency: number;
  waitMinutes: number;
  discardUnconfirmed: boolean;
}
export interface PregenerateDeps {
  service: RecallService;
  audio: ServerAudio;
  batch?: TtsBatchClient;
  out: (line: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Seconds of audio measured by the converter so far (interactive Gemini); estimated otherwise. */
  measuredSeconds?: () => number;
}

/** One distinct final text and every cache file that must hold its audio. */
export interface TextGroup { key: string; text: string; targets: AudioTarget[]; missing: AudioTarget[] }
export interface Inventory {
  concepts: number; items: number; sides: number; emptySides: number;
  groups: TextGroup[];
  /** Rewrite not cached: final text (and file name) unknown until rewritten. */
  unknown: { source: string; sides: { studyItemId: string; side: AudioSide }[] }[];
}

interface BatchRecord {
  displayName: string;
  /** `submitting` is written BEFORE the create call; `submitted` once the job name is known. */
  phase: 'submitting' | 'submitted';
  jobName?: string;
  intentAt: string;
  createdAt?: string;
  config: TtsBatchConfig;
  estimateUsd: number;
  /** `files`: cache file names (relative to the audio directory) that receive this text. */
  requests: { key: string; text: string; files: string[] }[];
  lastState?: string;
}
interface Usage { generated: number; files: number; failed: number; seconds: number; inputTokens: number; outputTokens: number; costBatchUsd: number; costStandardUsd: number }
export interface PregenerateState {
  version: 1;
  current: BatchRecord | null;
  failures: Record<string, { text: string; attempts: number; error: string; at: string; jobName?: string }>;
  totals: Usage & { batches: number };
  history: (Usage & { jobName: string; displayName: string; state: string; requests: number; createdAt?: string; collectedAt: string })[];
}

export class StopError extends Error {}

const emptyUsage = (): Usage => ({ generated: 0, files: 0, failed: 0, seconds: 0, inputTokens: 0, outputTokens: 0, costBatchUsd: 0, costStandardUsd: 0 });
const keyOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const usd = (n: number) => Number.isFinite(n) ? `$${n.toFixed(n < 1 ? 4 : 2)}` : 'n/a';
const chars = (text: string) => [...text].length;

/** Every card side → final text (when known) → cache files, grouped by identical text. */
export async function inventory(service: RecallService, audio: ServerAudio): Promise<Inventory> {
  const { concepts, items, sides } = await service.audioSides();
  const bySource = new Map<string, { studyItemId: string; side: AudioSide }[]>();
  let emptySides = 0;
  for (const s of sides) {
    const source = audioSource(s.voiceText);
    if (!source) { emptySides++; continue; }
    let list = bySource.get(source);
    if (!list) bySource.set(source, list = []);
    list.push({ studyItemId: s.studyItemId, side: s.side });
  }
  const inv: Inventory = { concepts, items, sides: sides.length - emptySides, emptySides, groups: [], unknown: [] };
  const groups = new Map<string, TextGroup>();
  for (const [source, list] of bySource) {
    const text = audio.rewriter ? await audio.rewriter.cached(source) : source;
    if (text === null) inv.unknown.push({ source, sides: list });
    else await addToGroups(audio, groups, text, list);
  }
  inv.groups = [...groups.values()];
  return inv;
}

async function addToGroups(audio: ServerAudio, groups: Map<string, TextGroup>, text: string, sides: { studyItemId: string; side: AudioSide }[]) {
  let group = groups.get(text);
  if (!group) groups.set(text, group = { key: keyOf(text), text, targets: [], missing: [] });
  for (const s of sides) {
    const target = audioTarget(audio, s.studyItemId, s.side, text);
    if (group.targets.some(t => t.path === target.path)) continue;
    group.targets.push(target);
    if (!await audio.cache.has(target.path)) group.missing.push(target);
  }
}

const needsSynthesis = (g: TextGroup) => g.missing.length === g.targets.length;
const copyable = (g: TextGroup) => g.missing.length > 0 && g.missing.length < g.targets.length;

function estimate(texts: string[], price: TokenPrice | null, tokensPerSecond: number) {
  const c = texts.reduce((n, t) => n + chars(t), 0);
  const seconds = texts.reduce((n, t) => n + estimateSeconds(chars(t)), 0);
  const inputTokens = texts.reduce((n, t) => n + estimateInputTokens(chars(t)), 0);
  return { chars: c, seconds, usd: price ? costUsd(price, inputTokens, seconds * tokensPerSecond) : NaN };
}

function describeConfig(audio: ServerAudio) {
  const { provider, model, voice, instructions } = audio.cache;
  return `provider ${provider}, model ${model}, voice ${voice}, instructions: ${instructions ? `"${instructions.slice(0, 60)}"` : 'none'}`;
}

/** --dry-run: counts and estimates only; no TTS and no LLM calls. */
export async function dryRun(deps: PregenerateDeps): Promise<Inventory> {
  const { audio, out } = deps;
  const now = deps.now?.() ?? new Date();
  const inv = await inventory(deps.service, audio);
  const missing = inv.groups.filter(needsSynthesis);
  const texts = [...missing.map(g => g.text), ...inv.unknown.map(u => u.source)];
  const model = audio.cache.model;
  const price = priceOn(model, now);
  out(`Configuration: ${describeConfig(audio)}`);
  out(`Cards: ${inv.concepts} concepts, ${inv.items} study items; ${inv.sides} sides with text (${inv.emptySides} empty)`);
  out(`Distinct texts: ${inv.groups.length + inv.unknown.length}`);
  out(`Already cached: ${inv.groups.filter(g => !g.missing.length).length} texts`);
  const copies = inv.groups.filter(copyable);
  if (copies.length) out(`Copy from existing cache files (no cost): ${copies.reduce((n, g) => n + g.missing.length, 0)} files of ${copies.length} texts`);
  const e = estimate(texts, price?.standard ?? null, price?.audioTokensPerSecond ?? 0);
  out(`Missing: ${texts.length} texts (${missing.reduce((n, g) => n + g.targets.length, 0) + inv.unknown.reduce((n, u) => n + u.sides.length, 0)} files), ${e.chars} characters, ~${Math.round(e.seconds)} s of audio (estimate)`);
  if (!price) out(`Estimated cost: unknown (no price for model ${model} in tts-prices.ts); --apply needs a known price`);
  else {
    const line = (p: { standard: TokenPrice; batch: TokenPrice | null }) => {
      const std = estimate(texts, p.standard, price.audioTokensPerSecond).usd;
      const batch = p.batch ? estimate(texts, p.batch, price.audioTokensPerSecond).usd : NaN;
      return `standard ${usd(std)}, batch ${p.batch ? usd(batch) : 'n/a'}`;
    };
    const next = nextPrice(model, now);
    out(`Estimated cost (${model}, prices from ${price.from}): ${line(price)}`);
    if (next) out(`Estimated cost at the prices from ${next.from}: ${line(next)}`);
  }
  if (audio.rewriter) {
    out(`Rewrites not cached yet: ${inv.unknown.length}` + (inv.unknown.length
      ? ' (their final text is unknown until rewritten: the estimate uses the pre-rewrite text; --apply rewrites them first, with LLM cost)' : ''));
  }
  out('Dry run: nothing was generated. Add --apply --max-usd=X to generate.');
  return inv;
}

/** Rewrites (through the rewrite cache) the first `count` unknown sources and adds them to the plan. */
async function resolveRewrites(deps: PregenerateDeps, inv: Inventory, count: number, concurrency: number): Promise<number> {
  const rewriter = deps.audio.rewriter;
  if (!rewriter || !inv.unknown.length || count <= 0) return 0;
  const todo = inv.unknown.splice(0, count);
  const groups = new Map(inv.groups.map(g => [g.text, g]));
  let failed = 0;
  deps.out(`Rewriting ${todo.length} texts (concurrency ${concurrency})…`);
  const results: (string | null)[] = new Array(todo.length).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, async () => {
    while (next < todo.length) {
      const i = next++;
      await rewriter.rewrite(todo[i].source);
      // A failed rewrite is not cached and falls back to the raw text; skip it rather than
      // synthesizing a text the route would not ask for once the rewrite succeeds.
      results[i] = await rewriter.cached(todo[i].source);
    }
  }));
  for (const [i, u] of todo.entries()) {
    if (results[i] === null) { failed++; inv.unknown.push(u); continue; }
    await addToGroups(deps.audio, groups, results[i]!, u.sides);
  }
  inv.groups = [...groups.values()];
  if (failed) deps.out(`${failed} rewrites failed and were skipped (re-run later)`);
  return failed;
}

/** Fills missing files of texts that already have a cache file (another study item). Free. */
async function copyExisting(audio: ServerAudio, inv: Inventory): Promise<number> {
  let copied = 0;
  for (const g of inv.groups.filter(copyable)) {
    const from = g.targets.find(t => !g.missing.includes(t))!;
    const data = await fileStorage().read(from.path);
    if (!data?.length) continue;
    for (const t of g.missing) { await audio.cache.store(t.path, data); copied++; }
    g.missing = [];
  }
  return copied;
}

export interface Summary {
  mode: string; generated: number; files: number; copied: number; skipped: number; failed: number;
  seconds: number; inputTokens: number; outputTokens: number; costUsd: number; costStandardUsd: number; costBatchUsd: number;
  remaining: number; stopped?: string; pending?: string; stateFile?: string;
}

function printSummary(out: (l: string) => void, s: Summary) {
  out(`Summary (${s.mode}):`);
  out(`  generated ${s.generated} texts → ${s.files} files; copied ${s.copied} files from cache; skipped ${s.skipped} texts already cached; failed ${s.failed}`);
  out(`  audio ${s.seconds.toFixed(1)} s; tokens in ${s.inputTokens}, out ${s.outputTokens}`);
  out(`  cost this run ${usd(s.costUsd)} (batch price basis ${usd(s.costBatchUsd)}, standard price basis ${usd(s.costStandardUsd)})`);
  out(`  remaining ${s.remaining} texts`);
  if (s.pending) out(`  pending: ${s.pending}`);
  if (s.stopped) out(`  stopped: ${s.stopped}`);
  if (s.stateFile) out(`  state file: ${s.stateFile}`);
}

function plannedWork(inv: Inventory, opts: PregenerateOptions, exclude: (g: TextGroup) => boolean) {
  const all = inv.groups.filter(needsSynthesis);
  const eligible = all.filter(g => !exclude(g));
  return { work: opts.limit === undefined ? eligible : eligible.slice(0, opts.limit), excluded: all.length - eligible.length };
}

async function prepare(deps: PregenerateDeps, opts: PregenerateOptions) {
  const inv = await inventory(deps.service, deps.audio);
  const knownMissing = inv.groups.filter(needsSynthesis).length;
  await resolveRewrites(deps, inv, opts.limit === undefined ? Infinity : Math.max(0, opts.limit - knownMissing), opts.concurrency);
  const skipped = inv.groups.filter(g => !g.missing.length).length;
  const copied = await copyExisting(deps.audio, inv);
  return { inv, copied, skipped };
}

/** --apply --mode=interactive: the normal TtsCache path, one text at a time per worker. */
export async function runInteractive(deps: PregenerateDeps, opts: PregenerateOptions): Promise<Summary> {
  const { audio, out } = deps;
  const price = priceOn(audio.cache.model, deps.now?.() ?? new Date());
  if (!price) throw new StopError(`No price for model ${audio.cache.model} in tts-prices.ts: the spend cap cannot be enforced`);
  const cap = opts.maxUsd!;
  const { inv, copied, skipped } = await prepare(deps, opts);
  const { work } = plannedWork(inv, opts, () => false);
  const s: Summary = { mode: 'interactive', generated: 0, files: 0, copied, skipped, failed: 0, seconds: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, costStandardUsd: 0, costBatchUsd: 0, remaining: 0 };
  const startSeconds = deps.measuredSeconds?.() ?? 0;
  let estimatedSeconds = 0, reserved = 0, consecutive = 0, next = 0;
  const spent = () => {
    const seconds = deps.measuredSeconds ? deps.measuredSeconds() - startSeconds : estimatedSeconds;
    s.seconds = seconds;
    s.outputTokens = Math.round(seconds * price.audioTokensPerSecond);
    s.costStandardUsd = costUsd(price.standard, s.inputTokens, s.outputTokens);
    s.costBatchUsd = price.batch ? costUsd(price.batch, s.inputTokens, s.outputTokens) : NaN;
    return s.costUsd = s.costStandardUsd;
  };
  out(`Interactive generation of ${work.length} texts (concurrency ${opts.concurrency}, cap ${usd(cap)})…`);
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, work.length) }, async () => {
    while (next < work.length && !s.stopped) {
      const g = work[next];
      const est = estimate([g.text], price.standard, price.audioTokensPerSecond).usd;
      if (spent() + reserved + est > cap) { s.stopped ??= `spend cap ${usd(cap)} reached (spent ${usd(spent())})`; return; }
      next++;
      reserved += est;
      try {
        const [first, ...rest] = g.missing;
        const data = await audio.cache.getOrGenerate(first.cacheId, first.cacheSide, g.text);
        for (const t of rest) await audio.cache.store(t.path, data);
        s.generated++; s.files += g.missing.length; consecutive = 0;
        s.inputTokens += estimateInputTokens(chars(g.text));
        estimatedSeconds += estimateSeconds(chars(g.text));
        g.missing = [];
      } catch (error) {
        if (error instanceof TtsDailyQuotaError) { s.stopped ??= `provider daily quota exhausted: ${(error as Error).message.slice(0, 200)}`; return; }
        s.failed++;
        out(`  failed: "${g.text.slice(0, 50)}": ${(error as Error)?.message ?? error}`);
        if (++consecutive >= 5) { s.stopped ??= '5 consecutive failures'; return; }
      } finally { reserved -= est; }
      if (spent() >= cap) s.stopped ??= `spend cap ${usd(cap)} reached`;
    }
  }));
  spent();
  s.remaining = inv.groups.filter(needsSynthesis).length + inv.unknown.length;
  out('Costs are estimated from measured audio length (Gemini) or from the text (OpenAI); the interactive API returns no usage.');
  printSummary(out, s);
  return s;
}

// ───────────────────────────── batch mode ─────────────────────────────

/** Atomic JSON state next to the cache. */
export class StateStore {
  constructor(readonly path: string) {}
  async load(): Promise<PregenerateState> {
    const data = await fileStorage().read(this.path);
    if (!data) return { version: 1, current: null, failures: {}, totals: { ...emptyUsage(), batches: 0 }, history: [] };
    const state = JSON.parse(data.toString('utf8')) as PregenerateState;
    if (state.version !== 1) throw new StopError(`Unknown state file version in ${this.path}`);
    return state;
  }
  save(state: PregenerateState): Promise<void> {
    return fileStorage().write(this.path, Buffer.from(JSON.stringify(state, null, 1)));
  }
}

class BatchRun {
  readonly usage = emptyUsage();
  private readonly price;
  constructor(private readonly deps: PregenerateDeps, private readonly opts: PregenerateOptions,
    private readonly store: StateStore, private readonly state: PregenerateState) {
    const price = priceOn(deps.audio.cache.model, deps.now?.() ?? new Date());
    if (!price?.batch) throw new StopError(`No batch price for model ${deps.audio.cache.model} in tts-prices.ts: the spend cap cannot be enforced`);
    this.price = { ...price, batch: price.batch };
  }
  get spent() { return this.usage.costBatchUsd; }
  private save() { return this.store.save(this.state); }
  private get batch() { return this.deps.batch!; }

  estimateUsd(texts: string[]) { return estimate(texts, this.price.batch, this.price.audioTokensPerSecond).usd; }

  /** A submission interrupted before its job name was saved: find it by display name, never resubmit blindly. */
  async recover(rec: BatchRecord): Promise<void> {
    let names: string[];
    try { names = await this.batch.findByDisplayName(rec.displayName); }
    catch (e) { throw new StopError(`An interrupted submission (${rec.displayName}) needs checking, but listing batches failed: ${(e as Error).message}`); }
    if (names.length === 1) {
      Object.assign(rec, { jobName: names[0], phase: 'submitted', createdAt: rec.createdAt ?? new Date().toISOString() });
      await this.save();
      this.deps.out(`Found the interrupted submission ${rec.displayName} at the provider: ${names[0]}`);
    } else if (names.length > 1) {
      throw new StopError(`Several batches are named ${rec.displayName} (${names.join(', ')}); set current.jobName in ${this.store.path} to the right one`);
    } else if (this.opts.discardUnconfirmed) {
      this.state.current = null;
      await this.save();
      this.deps.out(`Discarded the unconfirmed submission ${rec.displayName} (not found at the provider)`);
    } else {
      throw new StopError(`A submission (${rec.displayName}, ${rec.requests.length} requests, at ${rec.intentAt}) was interrupted before its job name was saved, `
        + 'and no batch with that name is listed. It may not have been created. Check the provider console; if it does not exist, re-run with --discard-unconfirmed.');
    }
  }

  /** Records intent, creates the job, records its name. Returns false when rejected for quota. */
  async submit(groups: TextGroup[], estimateUsd: number): Promise<boolean> {
    const { cache } = this.deps.audio;
    const rec: BatchRecord = {
      displayName: `recall-tts-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`,
      phase: 'submitting', intentAt: new Date().toISOString(), estimateUsd,
      config: { model: cache.model, voice: cache.voice, ...(cache.instructions ? { instructions: cache.instructions } : {}) },
      requests: groups.map(g => ({ key: g.key, text: g.text, files: g.missing.map(t => basename(t.path)) })),
    };
    this.state.current = rec;
    await this.save();
    let name: string;
    try {
      ({ name } = await this.batch.create(rec.displayName, rec.requests.map(r => ({ key: r.key, text: r.text })), rec.config));
    } catch (e) {
      if (e instanceof TtsBatchRejectedError) {
        this.state.current = null;
        await this.save();
        if (e.quota) { this.deps.out(`Batch of ${groups.length} rejected for quota: ${e.message}`); return false; }
        throw new StopError(e.message);
      }
      throw new StopError(`The create call for ${rec.displayName} failed without a clear answer (${(e as Error).message}). `
        + 'The job may exist: re-run to look it up by name before anything else is submitted.');
    }
    Object.assign(rec, { jobName: name, phase: 'submitted', createdAt: new Date().toISOString() });
    await this.save();
    this.deps.out(`Submitted ${name} (${rec.displayName}): ${groups.length} texts, estimate ${usd(estimateUsd)}`);
    return true;
  }

  /** Polls the current job until done (then stores its audio) or until --wait-minutes. */
  async collect(): Promise<'done' | 'pending'> {
    const rec = this.state.current!;
    const sleep = this.deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    const deadline = Date.now() + this.opts.waitMinutes * 60_000;
    let delay = 15_000, errors = 0;
    for (;;) {
      let job;
      try { job = await this.batch.get(rec.jobName!); errors = 0; }
      catch (e) {
        if (++errors >= 5) throw new StopError(`Cannot read ${rec.jobName}: ${(e as Error).message}. Re-run later to resume.`);
        job = null;
      }
      if (job?.done) { await this.storeResults(rec, job); return 'done'; }
      if (job && job.state !== rec.lastState) { rec.lastState = job.state; await this.save(); this.deps.out(`  ${rec.jobName}: ${job.state}`); }
      if (Date.now() + delay > deadline) return 'pending';
      await sleep(delay);
      delay = Math.min(delay * 1.5, 120_000);
    }
  }

  private async storeResults(rec: BatchRecord, job: Awaited<ReturnType<TtsBatchClient['get']>>): Promise<void> {
    const { audio, out } = this.deps;
    const u = emptyUsage();
    const byKey = new Map(rec.requests.map(r => [r.key, r]));
    const seen = new Set<string>();
    const fail = (key: string, text: string, error: string) => {
      const prev = this.state.failures[key];
      this.state.failures[key] = { text, attempts: (prev?.attempts ?? 0) + 1, error: error.slice(0, 300), at: new Date().toISOString(), jobName: rec.jobName };
      u.failed++;
      out(`  failed: "${text.slice(0, 50)}": ${error.slice(0, 200)}`);
    };
    if (job.succeeded && job.results) {
      for (const r of job.results) {
        const req = byKey.get(r.key);
        if (!req || seen.has(r.key)) { out(`  ignoring a result with unknown key "${r.key}"`); continue; }
        seen.add(r.key);
        if ('error' in r) { fail(r.key, req.text, r.error); continue; }
        try {
          if (!audio.convert) throw new Error('no WAV converter configured');
          const mp3 = await audio.convert(r.wav);
          // Idempotent: a re-run after a crash mid-collection rewrites only what is missing.
          for (const file of req.files) {
            const path = join(audio.cache.cacheDir, file);
            if (!await audio.cache.has(path)) await audio.cache.store(path, mp3);
          }
          u.generated++; u.files += req.files.length;
          u.seconds += wavSeconds(r.wav); u.inputTokens += r.promptTokens; u.outputTokens += r.outputTokens;
          delete this.state.failures[r.key];
        } catch (e) { fail(r.key, req.text, (e as Error).message); }
      }
      for (const req of rec.requests) if (!seen.has(req.key)) fail(req.key, req.text, 'missing from the batch results');
    } else {
      out(`  ${rec.jobName} ended in ${job.state}${job.error ? `: ${job.error}` : ''}`);
      for (const req of rec.requests) fail(req.key, req.text, `batch ${job.state}${job.error ? `: ${job.error}` : ''}`);
    }
    u.costBatchUsd = costUsd(this.price.batch, u.inputTokens, u.outputTokens);
    u.costStandardUsd = costUsd(this.price.standard, u.inputTokens, u.outputTokens);
    for (const k of Object.keys(u) as (keyof Usage)[]) { this.usage[k] += u[k]; this.state.totals[k] += u[k]; }
    this.state.totals.batches++;
    this.state.history.push({ ...u, jobName: rec.jobName!, displayName: rec.displayName, state: job.state, requests: rec.requests.length, createdAt: rec.createdAt, collectedAt: new Date().toISOString() });
    this.state.current = null;
    await this.save();
    out(`Collected ${rec.jobName}: ${u.generated} ok, ${u.failed} failed, ${u.seconds.toFixed(1)} s, ${usd(u.costBatchUsd)}`);
  }
}

/** --apply --mode=batch. One job at a time; resumable through the state file. */
export async function runBatch(deps: PregenerateDeps, opts: PregenerateOptions): Promise<Summary> {
  const { out } = deps;
  if (!deps.batch) throw new StopError('Batch mode needs a batch client (provider gemini)');
  const store = new StateStore(join(deps.audio.cache.cacheDir, STATE_FILE));
  const state = await store.load();
  const run = new BatchRun(deps, opts, store, state);
  const cap = opts.maxUsd!;
  const s: Summary = { mode: 'batch', generated: 0, files: 0, copied: 0, skipped: 0, failed: 0, seconds: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, costStandardUsd: 0, costBatchUsd: 0, remaining: 0, stateFile: store.path };
  const finish = (remaining: number) => {
    Object.assign(s, { generated: run.usage.generated, files: run.usage.files, failed: run.usage.failed, seconds: run.usage.seconds,
      inputTokens: run.usage.inputTokens, outputTokens: run.usage.outputTokens, costUsd: run.usage.costBatchUsd,
      costBatchUsd: run.usage.costBatchUsd, costStandardUsd: run.usage.costStandardUsd, remaining });
    printSummary(out, s);
    return s;
  };

  // 1. Finish what a previous run left: an interrupted submission or a job still running.
  if (state.current) {
    const rec = state.current;
    out(`Resuming ${rec.jobName ?? rec.displayName} (${rec.requests.length} texts) from ${store.path}`);
    if (rec.phase === 'submitting') await run.recover(rec);
    if (state.current?.jobName) {
      if (await run.collect() === 'pending') {
        s.pending = `${state.current.jobName} is still ${state.current.lastState ?? 'pending'}; re-run the same command to collect it`;
        return finish(await remaining(deps));
      }
    }
  }

  // 2. Plan what is still missing (files written above now count as cached).
  const { inv, copied, skipped } = await prepare(deps, opts);
  s.copied = copied; s.skipped = skipped;
  const isExhausted = (g: TextGroup) => (state.failures[g.key]?.attempts ?? 0) >= MAX_ATTEMPTS;
  const { work, excluded } = plannedWork(inv, opts, isExhausted);
  if (excluded) out(`${excluded} texts failed ${MAX_ATTEMPTS} times and are not submitted again (see "failures" in ${store.path})`);
  out(work.length ? `Batch generation of ${work.length} texts (batch size ${opts.batchSize}, cap ${usd(cap)})…` : 'Nothing to generate.');

  let size = opts.batchSize;
  while (work.length) {
    if (run.spent >= cap) { s.stopped = `spend cap ${usd(cap)} reached`; break; }
    let take = work.slice(0, size);
    while (take.length && run.spent + run.estimateUsd(take.map(g => g.text)) > cap) take = take.slice(0, Math.floor(take.length / 2));
    if (!take.length) { s.stopped = `the next text would exceed the spend cap ${usd(cap)} (spent ${usd(run.spent)})`; break; }
    if (!await run.submit(take, run.estimateUsd(take.map(g => g.text)))) {
      if (size <= MIN_BATCH) { s.stopped = 'batch creation rejected for quota even at the minimum size; re-run later'; break; }
      size = Math.max(MIN_BATCH, Math.floor(size / 2));
      out(`Retrying with batch size ${size}`);
      continue;
    }
    work.splice(0, take.length);
    if (await run.collect() === 'pending') {
      s.pending = `${state.current!.jobName} is still ${state.current!.lastState ?? 'pending'}; re-run the same command to collect it`;
      break;
    }
  }
  return finish(await remaining(deps));
}

/** Texts that still need audio: to synthesize, to copy from another item's file, or not rewritten yet. */
async function remaining(deps: PregenerateDeps): Promise<number> {
  const inv = await inventory(deps.service, deps.audio);
  return inv.groups.filter(g => g.missing.length).length + inv.unknown.length;
}

/** --orphans: cache MP3 files that no current side would use with the current configuration. Deletes nothing. */
export async function listOrphans(deps: PregenerateDeps, outFile?: string): Promise<string[]> {
  const { audio, out } = deps;
  const inv = await inventory(deps.service, audio);
  const expected = new Set(inv.groups.flatMap(g => g.targets.map(t => basename(t.path))));
  // A side whose rewrite is not cached has an unknown file name: keep any file it might own.
  const undetermined = inv.unknown.flatMap(u => u.sides.map(s => { const t = audioTarget(audio, s.studyItemId, s.side, ''); return `${t.cacheId}-${t.cacheSide}-`; }));
  let names: string[] = [];
  try { names = (await readdir(audio.cache.cacheDir, { withFileTypes: true })).filter(d => d.isFile() && d.name.endsWith('.mp3')).map(d => d.name); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const orphans = names.filter(n => !expected.has(n) && !undetermined.some(p => n.startsWith(p))).sort();
  let bytes = 0;
  for (const n of orphans) bytes += (await stat(join(audio.cache.cacheDir, n))).size;
  out(`Configuration: ${describeConfig(audio)}`);
  out(`Cache files: ${names.length} MP3; used by current card sides: ${names.length - orphans.length}; orphans: ${orphans.length} (${(bytes / 1048576).toFixed(1)} MiB)`);
  if (undetermined.length) out(`${undetermined.length} sides have no cached rewrite: their files were kept out of the orphan list`);
  for (const n of orphans.slice(0, 20)) out(`  ${n}`);
  if (orphans.length > 20) out(`  … ${orphans.length - 20} more`);
  if (outFile) {
    await writeFile(outFile, orphans.map(n => join(audio.cache.cacheDir, n)).join('\n') + (orphans.length ? '\n' : ''), { mode: 0o600 });
    out(`List written to ${outFile}`);
  }
  out('Nothing was deleted.');
  return orphans;
}
