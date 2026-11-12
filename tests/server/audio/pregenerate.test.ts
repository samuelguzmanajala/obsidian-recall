import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { RecallDatabase } from '../../../src/server/database';
import { RecallService } from '../../../src/server/service';
import { createRecallServer } from '../../../src/server/http';
import { configureAudio, type ServerAudio } from '../../../src/server/audio/configure-audio';
import { planAudio } from '../../../src/server/audio/audio-plan';
import {
  STATE_FILE, StopError, dryRun, inventory, listOrphans, runBatch, runInteractive, type PregenerateDeps, type PregenerateOptions, type PregenerateState,
} from '../../../src/server/audio/pregenerate-audio';
import { main, parseArgs } from '../../../src/server/pregenerate';
import { pcmToWav } from '@context/shared/infrastructure/gemini-tts-client';
import { TtsBatchRejectedError, type TtsBatchClient, type TtsBatchConfig, type TtsBatchJob, type TtsBatchRequest } from '@context/shared/domain/tts-batch-client';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
async function tempDir() { const d = await mkdtemp(join(tmpdir(), 'recall-pregen-')); cleanup.push(() => rm(d, { recursive: true, force: true })); return d; }

/** 5 one-way cards (one with an empty answer) + 1 bidirectional, two answers shared: 7 items, 13 sides with text, 10 distinct texts. */
const NOTE = 'Uno::Primero\nDos::Segundo\nTres::Compartida\nCuatro::Compartida\nHund:::Perro\nVacía::<span></span>';
const SECOND = 1;
const wav = (seconds = SECOND) => pcmToWav(Buffer.alloc(48000 * seconds));
const fakeMp3 = async (w: Buffer) => Buffer.concat([Buffer.from('mp3:'), Buffer.from(String(w.length))]);

/** The production server keeps writing to the file; the tool opens its own read-only connection. */
async function world(content = NOTE) {
  const dir = await tempDir();
  const dbPath = join(dir, 'recall.sqlite');
  const writer = new RecallDatabase(dbPath);
  cleanup.push(() => writer.close());
  const server = new RecallService(writer, { shuffleReviews: false, dailyNewLimit: 0 });
  await server.note({ operationId: randomUUID(), path: 'A.md', content, expectedRevision: 0 });
  const reader = new RecallDatabase(dbPath, { readOnly: true });
  cleanup.push(() => reader.close());
  const env = { RECALL_TTS_KEY: 'g-secret', RECALL_TTS_PROVIDER: 'gemini', RECALL_AUDIO_DIR: join(dir, 'audio') };
  const providerFetch = vi.fn(async () => { throw new Error('provider must not be called'); });
  const audio = configureAudio(env, { convert: fakeMp3, fetchImpl: providerFetch as unknown as typeof fetch })!;
  return { dir, dbPath, writer, server, reader, service: new RecallService(reader), audio, env, providerFetch, audioDir: join(dir, 'audio') };
}

class FakeBatch implements TtsBatchClient {
  jobs = new Map<string, { displayName: string; requests: TtsBatchRequest[]; config: TtsBatchConfig; polls: number }>();
  creates: TtsBatchRequest[][] = [];
  pendingPolls = 0;
  failTexts = new Set<string>();
  outputTokens = 25;
  /** Called on every create before anything happens; may throw. */
  beforeCreate?: (requests: TtsBatchRequest[]) => void;
  /** Called after the job exists; may throw (lost response). */
  afterCreate?: () => void;
  async create(displayName: string, requests: TtsBatchRequest[], config: TtsBatchConfig) {
    this.beforeCreate?.(requests);
    const name = `batches/job${this.jobs.size + 1}`;
    this.jobs.set(name, { displayName, requests, config, polls: 0 });
    this.creates.push(requests);
    this.afterCreate?.();
    return { name };
  }
  async get(name: string): Promise<TtsBatchJob> {
    const job = this.jobs.get(name)!;
    if (job.polls++ < this.pendingPolls) return { name, state: 'BATCH_STATE_RUNNING', done: false, succeeded: false };
    return { name, state: 'BATCH_STATE_SUCCEEDED', done: true, succeeded: true, results: job.requests.map(r => this.failTexts.has(r.text)
      ? { key: r.key, error: '3 Invalid argument' }
      : { key: r.key, wav: wav(), promptTokens: 10, outputTokens: this.outputTokens }) };
  }
  async findByDisplayName(displayName: string) {
    return [...this.jobs].filter(([, j]) => j.displayName === displayName).map(([name]) => name);
  }
}

const opts = (o: Partial<PregenerateOptions> = {}): PregenerateOptions =>
  ({ apply: true, mode: 'batch', maxUsd: 1, batchSize: 150, concurrency: 2, waitMinutes: 60, discardUnconfirmed: false, ...o });
function deps(w: Awaited<ReturnType<typeof world>>, batch?: TtsBatchClient, audio: ServerAudio = w.audio) {
  const lines: string[] = [];
  const d: PregenerateDeps = { service: w.service, audio, batch, out: l => lines.push(l), sleep: async () => {}, now: () => new Date('2026-11-12T10:00:00Z') };
  return { d, lines };
}
const mp3s = async (dir: string) => (existsSync(dir) ? await readdir(dir) : []).filter(f => f.endsWith('.mp3')).sort();
const state = async (dir: string) => JSON.parse(await readFile(join(dir, STATE_FILE), 'utf8')) as PregenerateState;

describe('pregeneration dry run', () => {
  it('reports cards, sides, distinct texts, cost at both prices, and calls nothing', async () => {
    const w = await world();
    const { d, lines } = deps(w);
    const inv = await dryRun(d);
    expect(inv).toMatchObject({ concepts: 6, items: 7, sides: 13, emptySides: 1 });
    expect(inv.groups).toHaveLength(10);
    const out = lines.join('\n');
    expect(out).toContain('Cards: 6 concepts, 7 study items; 13 sides with text (1 empty)');
    expect(out).toContain('Distinct texts: 10');
    expect(out).toContain('Already cached: 0 texts');
    expect(out).toMatch(/Missing: 10 texts \(13 files\), \d+ characters, ~\d+ s of audio/);
    expect(out).toMatch(/Estimated cost \(gemini-3.8-flash-tts, prices from 2026-01-01\): standard \$[\d.]+, batch \$[\d.]+/);
    expect(out).toMatch(/at the prices from 2027-01-01: standard/);
    expect(w.providerFetch).not.toHaveBeenCalled();
    expect(await mp3s(w.audioDir)).toEqual([]);
  });

  it('with a rewriter, counts uncached rewrites without calling the LLM', async () => {
    const w = await world();
    const llmFetch = vi.fn(async () => { throw new Error('LLM must not be called'); });
    const audio = configureAudio({ ...w.env, RECALL_LLM_PROVIDER: 'openai', RECALL_LLM_KEY: 'sk' }, { convert: fakeMp3, fetchImpl: llmFetch as unknown as typeof fetch })!;
    const { d, lines } = deps(w, undefined, audio);
    await dryRun(d);
    expect(lines.join('\n')).toContain('Rewrites not cached yet: 10 (their final text is unknown until rewritten: the estimate uses the pre-rewrite text');
    expect(llmFetch).not.toHaveBeenCalled();
  });
});

describe('pregeneration in batch mode', () => {
  it('synthesizes each distinct text once and fans it out to every cache path', async () => {
    const w = await world();
    const batch = new FakeBatch();
    const { d } = deps(w, batch);
    const summary = await runBatch(d, opts());
    expect(batch.creates).toHaveLength(1);
    expect(batch.creates[0]).toHaveLength(10);
    expect(new Set(batch.creates[0].map(r => r.text)).size).toBe(10);
    expect(summary).toMatchObject({ generated: 10, files: 13, failed: 0, remaining: 0, seconds: 10, inputTokens: 100, outputTokens: 250 });
    expect(summary.costBatchUsd).toBeCloseTo((100 * 0.25 + 250 * 4.5) / 1e6, 10);
    expect(await mp3s(w.audioDir)).toHaveLength(13);
    expect(batch.jobs.get('batches/job1')!.config).toEqual({ model: 'gemini-3.8-flash-tts', voice: 'Kore' });
  });

  it('writes exactly the files GET /audio serves, so the route never calls the provider', async () => {
    const w = await world();
    await runBatch(deps(w, new FakeBatch()).d, opts());
    const token = 'test-secret-'.repeat(4);
    const http = createRecallServer(w.server, token, w.audio);
    await new Promise<void>(r => http.listen(0, '127.0.0.1', r));
    cleanup.push(() => new Promise(r => http.close(r)));
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const items = await w.server.query(c => c.studyItemRepository.findAll());
    let served = 0;
    for (const item of items) for (const side of ['question', 'answer']) {
      const res = await fetch(`${url}/api/v1/audio/${item.id.value}/${side}`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 422) continue;
      expect(res.status).toBe(200);
      expect((await res.text()).startsWith('mp3:')).toBe(true);
      served++;
    }
    expect(served).toBe(13);
    expect(w.providerFetch).not.toHaveBeenCalled();
  });

  it('a second run has nothing to do', async () => {
    const w = await world();
    const batch = new FakeBatch();
    await runBatch(deps(w, batch).d, opts());
    const { d, lines } = deps(w, batch);
    const s = await runBatch(d, opts());
    expect(batch.creates).toHaveLength(1);
    expect(s).toMatchObject({ generated: 0, skipped: 10, remaining: 0 });
    expect(lines).toContain('Nothing to generate.');
  });

  it('copies an existing file to a study item that needs the same text, at no cost', async () => {
    const w = await world();
    const batch = new FakeBatch();
    await runBatch(deps(w, batch).d, opts());
    const files = await mp3s(w.audioDir);
    const { d } = deps(w, batch);
    const plan = (await inventory(w.service, w.audio)).groups.find(g => g.text === 'Compartida')!;
    await rm(plan.targets[1].path);
    const s = await runBatch(d, opts());
    expect(s).toMatchObject({ copied: 1, generated: 0 });
    expect(batch.creates).toHaveLength(1);
    expect(await mp3s(w.audioDir)).toEqual(files);
  });

  it('--limit submits only the first N missing texts', async () => {
    const w = await world();
    const batch = new FakeBatch();
    const s = await runBatch(deps(w, batch).d, opts({ limit: 3 }));
    expect(batch.creates.flat()).toHaveLength(3);
    expect(s).toMatchObject({ generated: 3, remaining: 7 });
  });

  it('records a per-request error, retries it once in a later run, then stops submitting it', async () => {
    const w = await world();
    const batch = new FakeBatch();
    batch.failTexts.add('Segundo');
    const first = await runBatch(deps(w, batch).d, opts());
    expect(first).toMatchObject({ generated: 9, failed: 1, remaining: 1 });
    const key = batch.creates[0].find(r => r.text === 'Segundo')!.key;
    expect((await state(w.audioDir)).failures[key]).toMatchObject({ text: 'Segundo', attempts: 1, error: '3 Invalid argument' });
    await runBatch(deps(w, batch).d, opts());
    expect(batch.creates[1].map(r => r.text)).toEqual(['Segundo']);
    expect((await state(w.audioDir)).failures[key].attempts).toBe(2);
    const { d, lines } = deps(w, batch);
    await runBatch(d, opts());
    expect(batch.creates).toHaveLength(2);
    expect(lines.join('\n')).toContain('1 texts failed 2 times and are not submitted again');
  });

  it('halves the batch after a quota rejection and stops cleanly at the floor', async () => {
    const w = await world(Array.from({ length: 12 }, (_, i) => `Pregunta ${i}::Respuesta ${i}`).join('\n'));
    const batch = new FakeBatch();
    batch.beforeCreate = r => { if (r.length > 12) throw new TtsBatchRejectedError('429 enqueued tokens', true); };
    const s = await runBatch(deps(w, batch).d, opts({ batchSize: 40 }));
    expect(batch.creates.map(r => r.length)).toEqual([10, 10, 4]);
    expect(s).toMatchObject({ generated: 24, remaining: 0 });
    expect((await state(w.audioDir)).current).toBeNull();

    const w2 = await world();
    const always = new FakeBatch();
    always.beforeCreate = () => { throw new TtsBatchRejectedError('429 quota', true); };
    const s2 = await runBatch(deps(w2, always).d, opts({ batchSize: 20 }));
    expect(s2.stopped).toMatch(/rejected for quota even at the minimum size/);
    expect(s2.remaining).toBe(10);
    expect((await state(w2.audioDir)).current).toBeNull();
  });

  it('honours the cap: never submits past the estimate and stops once real usage reaches it', async () => {
    const w = await world();
    const batch = new FakeBatch();
    const tiny = await runBatch(deps(w, batch).d, opts({ maxUsd: 0.000001 }));
    expect(batch.creates).toHaveLength(0);
    expect(tiny.stopped).toMatch(/would exceed the spend cap/);

    batch.outputTokens = 1_000_000; // real usage far above the estimate
    const s = await runBatch(deps(w, batch).d, opts({ maxUsd: 0.05, batchSize: 2 }));
    expect(batch.creates).toHaveLength(1);
    expect(s.stopped).toMatch(/spend cap \$0.0500 reached/);
    expect(s.costUsd).toBeGreaterThan(0.05);
  });

  describe('resumes after a crash without submitting twice', () => {
    it('crash before the create call reached the provider: stops, then --discard-unconfirmed proceeds', async () => {
      const w = await world();
      const batch = new FakeBatch();
      batch.beforeCreate = () => { throw new Error('socket hang up'); };
      await expect(runBatch(deps(w, batch).d, opts())).rejects.toThrow(/failed without a clear answer/);
      expect((await state(w.audioDir)).current).toMatchObject({ phase: 'submitting' });
      batch.beforeCreate = undefined;
      await expect(runBatch(deps(w, batch).d, opts())).rejects.toThrow(/re-run with --discard-unconfirmed/);
      expect(batch.creates).toHaveLength(0);
      const s = await runBatch(deps(w, batch).d, opts({ discardUnconfirmed: true }));
      expect(batch.creates).toHaveLength(1);
      expect(s).toMatchObject({ generated: 10, remaining: 0 });
    });

    it('crash after the job was created but before its name was saved: found by display name', async () => {
      const w = await world();
      const batch = new FakeBatch();
      batch.afterCreate = () => { throw new Error('connection reset'); };
      await expect(runBatch(deps(w, batch).d, opts())).rejects.toThrow(StopError);
      const saved = (await state(w.audioDir)).current!;
      expect(saved).toMatchObject({ phase: 'submitting' });
      expect(saved.jobName).toBeUndefined();
      batch.afterCreate = undefined;
      const { d, lines } = deps(w, batch);
      const s = await runBatch(d, opts());
      expect(lines.join('\n')).toContain('Found the interrupted submission');
      expect(batch.creates).toHaveLength(1);
      expect(s).toMatchObject({ generated: 10, remaining: 0 });
    });

    it('job still running when the wait ends: left in the state file and collected by the next run', async () => {
      const w = await world();
      const batch = new FakeBatch();
      batch.pendingPolls = 1000;
      const first = await runBatch(deps(w, batch).d, opts({ waitMinutes: 1 }));
      expect(first.pending).toMatch(/batches\/job1 is still BATCH_STATE_RUNNING/);
      expect((await state(w.audioDir)).current).toMatchObject({ phase: 'submitted', jobName: 'batches/job1' });
      batch.pendingPolls = 0;
      const second = await runBatch(deps(w, batch).d, opts());
      expect(batch.creates).toHaveLength(1);
      expect(second).toMatchObject({ generated: 10, remaining: 0 });
    }, 10_000);

    it('crash in the middle of collecting: re-fetches the results and writes only what is missing', async () => {
      const w = await world();
      const batch = new FakeBatch();
      batch.pendingPolls = 1000;
      await runBatch(deps(w, batch).d, opts({ waitMinutes: 1 }));
      const statePath = join(w.audioDir, STATE_FILE);
      await copyFile(statePath, `${statePath}.before`);
      batch.pendingPolls = 0;
      await runBatch(deps(w, batch).d, opts());
      // Back to "submitted" with only part of the files written.
      await copyFile(`${statePath}.before`, statePath);
      const files = await mp3s(w.audioDir);
      for (const f of files.slice(0, 5)) await rm(join(w.audioDir, f));
      const s = await runBatch(deps(w, batch).d, opts());
      expect(batch.creates).toHaveLength(1);
      expect(await mp3s(w.audioDir)).toEqual(files);
      expect(s.remaining).toBe(0);
      expect((await state(w.audioDir)).history).toHaveLength(1);
    }, 10_000);
  });
});

describe('pregeneration in interactive mode', () => {
  it('fans out like batch mode and stops cleanly on the daily quota, reporting what remains', async () => {
    const w = await world();
    let calls = 0;
    const fetchImpl = vi.fn(async () => ++calls <= 2
      ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: wav().toString('base64') } }] } }] }))
      : new Response(JSON.stringify({ error: { code: 429, message: 'Quota exceeded for metric: generate_requests_per_model_per_day' } }), { status: 429 }));
    const audio = configureAudio(w.env, { convert: fakeMp3, fetchImpl: fetchImpl as unknown as typeof fetch })!;
    const { d } = deps(w, undefined, audio);
    const s = await runInteractive(d, opts({ mode: 'interactive', concurrency: 1 }));
    expect(s.stopped).toMatch(/daily quota/);
    expect(s).toMatchObject({ generated: 2, remaining: 8 });
    expect(calls).toBe(3);
  });

  it('refuses to start past the cap', async () => {
    const w = await world();
    const { d } = deps(w);
    const s = await runInteractive(d, opts({ mode: 'interactive', maxUsd: 0.000001 }));
    expect(s.generated).toBe(0);
    expect(s.stopped).toMatch(/spend cap/);
    expect(w.providerFetch).not.toHaveBeenCalled();
  });
});

describe('read-only database access', () => {
  it('never writes: the connection rejects writes and the tool leaves the file unchanged', async () => {
    const w = await world();
    expect(() => w.reader.sql.exec("INSERT INTO meta VALUES ('x','y')")).toThrow(/readonly|read-only|query_only/i);
    const before = w.writer.sql.prepare('SELECT COUNT(*) AS n FROM item_revisions').get();
    await runBatch(deps(w, new FakeBatch()).d, opts());
    expect(w.writer.sql.prepare('SELECT COUNT(*) AS n FROM item_revisions').get()).toEqual(before);
    // The live server keeps working alongside the read-only connection.
    await w.server.note({ operationId: randomUUID(), path: 'B.md', content: 'Nuevo::Card', expectedRevision: 0 });
  });

  it('refuses a database whose schema version is not the current one (and never migrates it)', async () => {
    const dir = await tempDir();
    const path = join(dir, 'old.sqlite');
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA user_version=3');
    raw.close();
    expect(() => new RecallDatabase(path, { readOnly: true })).toThrow(/schema version is 3, this build expects 5.*never migrates/);
    const check = new DatabaseSync(path);
    expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 });
    check.close();
  });
});

describe('orphan listing', () => {
  it('lists cache files no current side uses and deletes nothing', async () => {
    const w = await world();
    await runBatch(deps(w, new FakeBatch()).d, opts());
    await writeFile(join(w.audioDir, 'deadbeef-q-000000000000.mp3'), 'old');
    await writeFile(join(w.audioDir, 'notes.txt'), 'not audio');
    const out = join(w.dir, 'orphans.txt');
    const { d, lines } = deps(w);
    expect(await listOrphans(d, out)).toEqual(['deadbeef-q-000000000000.mp3']);
    expect(await readFile(out, 'utf8')).toBe(`${join(w.audioDir, 'deadbeef-q-000000000000.mp3')}\n`);
    expect(lines).toContain('Nothing was deleted.');
    expect(await mp3s(w.audioDir)).toHaveLength(14);
  });
});

describe('the shared audio plan', () => {
  it('renaming a note keeps study item ids, so every cache path stays the same', async () => {
    const w = await world();
    const paths = async () => (await inventory(w.service, w.audio)).groups.flatMap(g => g.targets.map(t => t.path)).sort();
    const before = await paths();
    await w.server.renameNote({ operationId: randomUUID(), path: 'A.md', newPath: 'Renamed.md', expectedRevision: 1 });
    expect(await paths()).toEqual(before);
    const item = (await w.server.query(c => c.studyItemRepository.findAll()))[0].id.value;
    const plan = await planAudio(w.audio, item, 'question', 'Uno');
    expect(before).toContain(plan!.path);
  });
});

describe('pregenerate CLI', () => {
  it('defaults to a dry run and validates flags', () => {
    expect(parseArgs([], 'gemini')).toMatchObject({ apply: false, mode: 'batch', batchSize: 150, concurrency: 2 });
    expect(parseArgs([], 'openai').mode).toBe('interactive');
    expect(() => parseArgs(['--apply'], 'gemini')).toThrow(/requires --max-usd/);
    expect(() => parseArgs(['--apply', '--max-usd=1', '--mode=batch'], 'openai')).toThrow(/needs RECALL_TTS_PROVIDER=gemini/);
    expect(() => parseArgs(['--frobnicate'], 'gemini')).toThrow(/Unknown option/);
    expect(() => parseArgs(['--limit=0'], 'gemini')).toThrow(/positive integer/);
    expect(parseArgs(['--apply', '--max-usd=0.5', '--limit=3', '--batch-size=50'], 'gemini')).toMatchObject({ apply: true, maxUsd: 0.5, limit: 3, batchSize: 50 });
  });

  it('runs a dry run end to end without printing the key', async () => {
    const w = await world();
    const lines: string[] = [];
    const code = await main([], { ...w.env, RECALL_TTS_KEY: 'AIza-cli-secret', RECALL_DB: w.dbPath }, l => lines.push(l));
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('Mode: dry run (default)');
    expect(lines.join('\n')).toContain('Distinct texts: 10');
    expect(lines.join('\n')).not.toContain('AIza-cli-secret');
  });

  it('--apply creates the audio directory, takes and releases the lock, and stops at the cap before any call', async () => {
    const w = await world();
    const lines: string[] = [];
    const audioDir = join(w.dir, 'new-audio');
    const code = await main(['--apply', '--max-usd=0.000001'], { RECALL_TTS_KEY: 'sk-x', RECALL_DB: w.dbPath, RECALL_AUDIO_DIR: audioDir }, l => lines.push(l));
    expect(code).toBe(2);
    expect(lines.join('\n')).toMatch(/stopped: spend cap/);
    expect(await readdir(audioDir)).toEqual([]);
  });

  it('reports a wrong schema version as a clear stop', async () => {
    const dir = await tempDir();
    const path = join(dir, 'v3.sqlite');
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA user_version=3');
    raw.close();
    const lines: string[] = [];
    expect(await main([], { RECALL_TTS_KEY: 'k', RECALL_TTS_PROVIDER: 'gemini', RECALL_DB: path, RECALL_AUDIO_DIR: dir }, l => lines.push(l))).toBe(1);
    expect(lines.at(-1)).toMatch(/^Error: Database schema version is 3/);
  });
});
