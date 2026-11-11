import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RecallDatabase } from '../../../src/server/database';
import { RecallService } from '../../../src/server/service';
import { createRecallServer } from '../../../src/server/http';
import { AudioQueue } from '../../../src/server/audio/audio-queue';
import { ensureAudio } from '../../../src/server/audio/audio-plan';
import { TtsCache } from '../../../src/server/audio/tts-cache';
import { fileStorage } from '../../../src/server/audio/configure-audio';
import { TtsDailyQuotaError } from '@context/shared/domain/tts-client';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
const tick = () => new Promise(r => setTimeout(r, 5));
async function until(check: () => boolean) { for (let i = 0; i < 200 && !check(); i++) await tick(); expect(check()).toBe(true); }

describe('AudioQueue', () => {
  it('generates both sides one at a time, de-duplicated', async () => {
    const calls: string[] = [];
    let release!: () => void;
    let gate = new Promise<void>(r => { release = r; });
    const queue = new AudioQueue(async (id, side) => { calls.push(`${id}/${side}`); await gate; });
    queue.enqueue(['a', 'a', 'b']);
    await until(() => calls.length === 1);
    queue.enqueue(['b', 'a']); // b pending already; a is being generated, so its other side stays queued once
    gate = Promise.resolve(); release();
    await until(() => queue.size === 0 && calls.length >= 5);
    await tick();
    expect(calls).toEqual(['a/question', 'a/answer', 'b/question', 'b/answer', 'a/question']);
  });

  it('drops the queue on the daily quota with one log line, and pauses new work', async () => {
    let now = 0;
    const log = vi.fn();
    const generate = vi.fn().mockRejectedValueOnce(new TtsDailyQuotaError('429 per day')).mockResolvedValue(undefined);
    const queue = new AudioQueue(generate, { log, now: () => now, pauseMs: 1000 });
    queue.enqueue(['a', 'b', 'c']);
    await until(() => log.mock.calls.length === 1);
    queue.enqueue(['d']);
    await tick();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/daily quota exhausted.*6 side\(s\) dropped/);
    now = 1000;
    queue.enqueue(['e']);
    await until(() => generate.mock.calls.length === 3);
  });

  it('shutdown drops pending work and does not wait for a stuck provider', async () => {
    const generate = vi.fn(() => new Promise(() => {}));
    const queue = new AudioQueue(generate);
    queue.enqueue(['a', 'b']);
    await until(() => generate.mock.calls.length === 1);
    const started = Date.now();
    await queue.close(50);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(queue.size).toBe(0);
    queue.enqueue(['c']);
    await tick();
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe('background audio after POST /api/v1/notes', () => {
  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'recall-queue-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const db = new RecallDatabase(':memory:');
    cleanup.push(() => db.close());
    const service = new RecallService(db, { shuffleReviews: false, dailyNewLimit: 0 });
    let release!: () => void;
    const unblock = new Promise<void>(r => { release = r; });
    const synthesize = vi.fn(async () => { await unblock; return Buffer.from('mp3'); });
    const audio = { cache: new TtsCache(fileStorage(), { isConfigured: () => true, synthesize }, dir), rewriter: null };
    const queue = new AudioQueue((id, side) => ensureAudio(service, audio, id, side));
    cleanup.push(() => queue.close());
    const token = 'test-secret-'.repeat(4);
    const server = createRecallServer(service, token, audio, queue);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    cleanup.push(() => new Promise(r => server.close(r)));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { dir, service, synthesize, release, queue, post };
  }

  it('answers while synthesis is still blocked, then fills the cache for both sides', async () => {
    const { dir, synthesize, release, post } = await setup();
    const res = await post('/api/v1/notes', { operationId: randomUUID(), path: 'A.md', content: 'Uno::Primero', expectedRevision: 0 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: 'A.md', revision: 1 });
    await until(() => synthesize.mock.calls.length === 1);
    expect(await readdir(dir)).toEqual([]); // the response came back with synthesis still blocked
    release();
    await until(() => synthesize.mock.calls.length === 2);
    await tick();
    expect((await readdir(dir)).filter(f => f.endsWith('.mp3'))).toHaveLength(2);
  });

  it('does not enqueue on rename (ids and file names are unchanged) or on an idempotent retry', async () => {
    const { queue, post, release } = await setup();
    release();
    const enqueue = vi.spyOn(queue, 'enqueue');
    const body = { operationId: randomUUID(), path: 'A.md', content: 'Uno::Primero', expectedRevision: 0 };
    await post('/api/v1/notes', body);
    await post('/api/v1/notes', body);
    expect(enqueue).toHaveBeenCalledTimes(1);
    await post('/api/v1/notes/rename', { operationId: randomUUID(), path: 'A.md', newPath: 'B.md', expectedRevision: 1 });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('never fails the request when the listener throws', async () => {
    const db = new RecallDatabase(':memory:');
    cleanup.push(() => db.close());
    const service = new RecallService(db);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(service.note({ operationId: randomUUID(), path: 'A.md', content: 'Uno::Primero', expectedRevision: 0 }, () => { throw new Error('boom'); }))
      .resolves.toEqual({ path: 'A.md', revision: 1 });
    error.mockRestore();
  });
});
