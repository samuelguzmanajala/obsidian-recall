import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteError, type RemoteClient } from '../../../src/app/backend/remote-client';
import { contentHash, RemoteNoteSync, type NoteJob } from '../../../src/app/backend/remote-note-sync';
import { KeyDebouncer } from '../../../src/app/backend/key-debouncer';

type Note = { revision: number; content: string | null; hash: string | null };
type Sent = { operationId: string; path: string; content: string | null };
/** Just enough of the backend's /notes contract, with idempotent operation IDs. */
function fakeBackend() {
  const notes = new Map<string, Note>();
  const receipts = new Map<string, unknown>();
  const sent: Sent[] = [];
  let loseNextReceipt = false;
  const client = {
    async request(path: string, body?: any) {
      if (path === '/notes' && body === undefined) {
        return { notes: [...notes].map(([p, n]) => ({ path: p, revision: n.revision, deleted: n.content === null, hash: n.hash })) };
      }
      if (receipts.has(body.operationId)) return receipts.get(body.operationId);
      if (path === '/notes') {
        sent.push({ operationId: body.operationId, path: body.path, content: body.content });
        const current = notes.get(body.path);
        if ((current?.revision ?? 0) !== body.expectedRevision) throw new RemoteError(409, 'conflict');
        const revision = (current?.revision ?? 0) + 1;
        notes.set(body.path, { revision, content: body.content, hash: body.content === null ? null : await contentHash(body.content) });
        receipts.set(body.operationId, { revision });
      } else throw new Error(`unexpected ${path}`);
      if (loseNextReceipt) { loseNextReceipt = false; throw new Error('Lost receipt'); }
      return receipts.get(body.operationId);
    },
  };
  return { notes, sent, client: client as unknown as RemoteClient, loseReceipt: () => { loseNextReceipt = true; } };
}
function storage() {
  let stored: NoteJob[] = []; let saves = 0; let raw = '[]';
  const journal = {
    load: () => JSON.parse(raw), save: (jobs: NoteJob[]) => { saves++; raw = JSON.stringify(jobs); stored = JSON.parse(raw); },
  };
  return { journal, get stored() { return stored; }, get raw() { return raw; }, set raw(value: string) { raw = value; }, get saves() { return saves; } };
}

describe('RemoteNoteSync journal', () => {
  it('journals unsent edits without their content, in one write per batch', async () => {
    const { client } = fakeBackend(); const store = storage();
    const sync = new RemoteNoteSync(client, {}, () => {}, store.journal, async () => null);
    const body = 'Q::A long answer '.repeat(200);
    await sync.batch(async () => {
      for (let i = 0; i < 50; i++) await sync.stageCurrent(`Note ${i}.md`, `${body}${i}`);
    });
    expect(store.saves).toBe(1);
    expect(sync.pendingCount).toBe(50);
    expect(store.stored).toHaveLength(50);
    expect(store.raw).not.toContain('long answer');
    expect(store.raw.length).toBeLessThan(50 * 120);
    await sync.stageCurrent('Outside.md', 'Q::A');
    expect(store.saves).toBe(2);
  });

  it('publishes the current vault content after reload and retires vanished paths without deleting', async () => {
    const { client, notes, sent } = fakeBackend(); const store = storage();
    const first = new RemoteNoteSync(client, {}, () => {}, store.journal, async () => null);
    await first.stageCurrent('Kept.md', 'Q::Staged');
    await first.stageCurrent('Gone.md', 'Q::Staged');
    first.close();
    const vault: Record<string, string> = { 'Kept.md': 'Q::Edited while closed' };
    const state = {};
    const recovered = new RemoteNoteSync(client, state, () => {}, store.journal, async path => vault[path] ?? null);
    await recovered.retry();
    expect(recovered.pendingCount).toBe(0); expect(store.stored).toEqual([]);
    expect(notes.get('Kept.md')?.content).toBe('Q::Edited while closed');
    expect(notes.has('Gone.md')).toBe(false);
    expect(sent.map(s => s.path)).toEqual(['Kept.md']);
    expect(() => new RemoteNoteSync(client, {}, () => {}, {
      load: () => [{ operationId: 'x', path: 'Kept.md' }], save: () => {},
    })).toThrow('Invalid note journal');
  });

  it('replays a prepared payload with its operation ID and exact content after reload', async () => {
    const backend = fakeBackend(); const store = storage();
    const sync = new RemoteNoteSync(backend.client, {}, () => {}, store.journal, async () => 'Q::Sent');
    backend.loseReceipt();
    await expect(sync.publish('Test.md', 'Q::Sent')).rejects.toThrow('Lost receipt');
    expect(store.stored).toHaveLength(1);
    expect(store.stored[0]).toMatchObject({ content: 'Q::Sent', expectedRevision: 0 });
    const recovered = new RemoteNoteSync(backend.client, {}, () => {}, store.journal, async () => 'Q::Something newer');
    await recovered.retry();
    expect(store.stored).toEqual([]);
    expect(backend.sent).toHaveLength(1);
    expect(backend.notes.get('Test.md')).toMatchObject({ revision: 1, content: 'Q::Sent' });
  });

  it('reads a reloaded path-only edit to retire a conflicted prefix already on the server', async () => {
    const { client, notes, sent } = fakeBackend(); const store = storage();
    let state: any = {}; const persist = (next: any) => { state = structuredClone(next); };
    const sync = new RemoteNoteSync(client, state, persist, store.journal, async () => null);
    await sync.publish('Test.md', 'Q::Base');
    notes.set('Test.md', { revision: 2, content: 'Q::Remote', hash: await contentHash('Q::Remote') });
    await expect(sync.publish('Test.md', 'Q::Local')).rejects.toMatchObject({ status: 409 });
    await sync.stageCurrent('Test.md', 'Q::Remote');
    expect(store.stored[1]).toEqual({ operationId: expect.any(String), path: 'Test.md' });
    sync.close();
    const recovered = new RemoteNoteSync(client, state, persist, store.journal, async () => 'Q::Remote');
    await recovered.retry();
    expect(recovered.pendingCount).toBe(0);
    expect(notes.get('Test.md')).toMatchObject({ revision: 2, content: 'Q::Remote' });
    expect(sent.filter(s => s.content === 'Q::Remote')).toEqual([]);
  });

  it('loads and publishes a journal written with content on every job', async () => {
    const { client, notes } = fakeBackend(); const store = storage();
    store.raw = JSON.stringify([{ operationId: 'a', path: 'Old.md', content: 'Q::Old format' }]);
    const reader = vi.fn(async () => 'Q::Ignored');
    await new RemoteNoteSync(client, {}, () => {}, store.journal, reader).retry();
    expect(notes.get('Old.md')?.content).toBe('Q::Old format');
    expect(reader).not.toHaveBeenCalled();
    expect(store.stored).toEqual([]);
  });
});

describe('RemoteNoteSync excluded paths', () => {
  it('drops journaled work for excluded paths at startup without touching cursors or the backend', async () => {
    const backend = fakeBackend(); const store = storage();
    const excluded = (path: string) => path.split('/').includes('node_modules');
    const jobs: NoteJob[] = [
      { operationId: 'n1', path: 'A.md' },
      { operationId: 'x1', path: 'node_modules/fsevents/README.md' },
      { operationId: 'x2', path: 'lib/node_modules/p/Doc.md', content: 'Q::Inline' },
      { operationId: 'n2', path: 'B.md', content: 'Q::B' },
      { operationId: 'x3', path: 'node_modules/pkg/CHANGELOG.md', content: 'Q::Sent', expectedRevision: 2, hash: 'h', baseHash: 'b' },
      { operationId: 'x4', path: 'node_modules/gone.md', content: null },
      { operationId: 'x5', path: 'node_modules/a.md', newPath: 'node_modules/b.md' },
      { operationId: 'k1', path: 'node_modules/in.md', newPath: 'Out.md' },
      { operationId: 'k2', path: 'Into.md', newPath: 'node_modules/into.md' },
      { operationId: 'n3', path: 'C.md' },
    ];
    store.raw = JSON.stringify(jobs);
    const state = { 'node_modules/pkg/CHANGELOG.md': { revision: 1, hash: 'old' } };
    const cursors = structuredClone(state);
    const persist = vi.fn();
    const vault: Record<string, string> = { 'A.md': 'Q::A', 'C.md': 'Q::C', 'node_modules/fsevents/README.md': 'Q::Local' };
    const sync = new RemoteNoteSync(backend.client, state, persist, store.journal, async path => vault[path] ?? null);
    expect(sync.discardExcluded(excluded)).toBe(5);
    expect(store.saves).toBe(1);
    expect(store.stored.map(job => job.operationId)).toEqual(['n1', 'n2', 'k1', 'k2', 'n3']);
    expect(sync.pendingCount).toBe(5);
    expect(sync.conflictPath).toBeNull();
    expect(state).toEqual(cursors);
    expect(persist).not.toHaveBeenCalled();
    expect(backend.sent).toEqual([]);
    // A second pass finds nothing to drop and does not rewrite the journal.
    expect(sync.discardExcluded(excluded)).toBe(0);
    expect(store.saves).toBe(1);

    // The half-excluded renames are left alone; with no cursor they wait for reconciliation.
    await expect(sync.retry()).rejects.toThrow();
    expect(backend.sent.map(s => s.path)).toEqual(['A.md', 'B.md', 'C.md']);
    expect(backend.sent.some(s => excluded(s.path))).toBe(false);
    expect(store.stored.map(job => job.operationId)).toEqual(['k1', 'k2']);
    expect(state).toMatchObject(cursors);
  });

  it('reaches an empty queue when only excluded work was pending', async () => {
    const backend = fakeBackend(); const store = storage();
    store.raw = JSON.stringify([{ operationId: 'x', path: 'node_modules/fsevents/README.md' }]);
    backend.notes.set('node_modules/fsevents/README.md', { revision: 1, content: 'Q::Remote', hash: await contentHash('Q::Remote') });
    const sync = new RemoteNoteSync(backend.client, {}, () => {}, store.journal, async () => 'Q::Local');
    await expect(sync.retry()).rejects.toThrow('conflicto');
    expect(sync.conflictPath).toBe('node_modules/fsevents/README.md');
    sync.discardExcluded(path => path.split('/').includes('node_modules'));
    expect(sync.conflictPath).toBeNull();
    expect(sync.pendingCount).toBe(0);
    await sync.retry();
    expect(backend.sent).toEqual([]);
    expect(backend.notes.get('node_modules/fsevents/README.md')?.content).toBe('Q::Remote');
  });
});

describe('KeyDebouncer', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('runs only the last call per key and honours cancel and clear', () => {
    vi.useFakeTimers();
    const runs: string[] = [];
    const edits = new KeyDebouncer(2000);
    edits.schedule('A', () => runs.push('A1'));
    vi.advanceTimersByTime(1500);
    edits.schedule('A', () => runs.push('A2'));
    edits.schedule('B', () => runs.push('B'));
    edits.schedule('C', () => runs.push('C'));
    edits.cancel('B');
    vi.advanceTimersByTime(1999);
    expect(runs).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(runs).toEqual(['A2', 'C']);
    edits.schedule('D', () => runs.push('D'));
    edits.clear();
    vi.advanceTimersByTime(5000);
    expect(runs).toEqual(['A2', 'C']);
  });
});
