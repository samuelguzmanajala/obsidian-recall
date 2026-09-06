import { RemoteClient, RemoteError, type RemoteNote } from './remote-client';

type Acknowledged = Record<string, { revision: number; hash: string | null }>;
export type NoteJob = {
  operationId: string; path: string; content?: string | null; newPath?: string;
  expectedRevision?: number; hash?: string | null;
};
export interface NoteJournal { load(): NoteJob[]; save(jobs: NoteJob[]): void }
export async function contentHash(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Ordered, durable publication. Never infer a deletion from an absent local file. */
export class RemoteNoteSync {
  private tail: Promise<unknown> = Promise.resolve();
  private jobs: NoteJob[];
  private activeJob: NoteJob | null = null;
  private conflict: NoteJob | null = null;
  private closed = false;
  close(): void { this.closed = true; }
  private assertOpen(): void { if (this.closed) throw new Error('Recall publisher closed; journal retained for recovery'); }
  constructor(private client: RemoteClient, private state: Acknowledged,
    private persist: (state: Acknowledged) => void, private journal?: NoteJournal) {
    this.jobs = journal?.load() ?? [];
    if (!Array.isArray(this.jobs) || this.jobs.some(j => !j.operationId || !j.path
      || (!j.newPath && j.content !== null && typeof j.content !== 'string'))) {
      throw new Error('Invalid note journal; restore it before publishing');
    }
  }
  get pendingCount(): number { return this.jobs.length; }
  get conflictPath(): string | null { return this.conflict?.path ?? null; }
  get knownPaths(): string[] { return Object.keys(this.state).filter(path => this.state[path].hash !== null); }
  private save(): void { this.assertOpen(); this.journal?.save(this.jobs); }
  private append(job: NoteJob): void {
    this.assertOpen();
    const last = this.jobs.at(-1);
    // Never replace a payload once it has been prepared for sending.
    if (last && last !== this.activeJob && !last.newPath && !job.newPath && last.path === job.path && last.expectedRevision === undefined) {
      last.content = job.content;
    } else this.jobs.push(job);
    this.save();
  }
  publish(path: string, content: string | null): Promise<void> {
    this.append({ operationId: crypto.randomUUID(), path, content });
    return this.retry();
  }
  async stageCurrent(path: string, content: string): Promise<void> {
    if (!this.jobs.some(job => job.path === path || job.newPath === path)
      && this.state[path]?.hash === await contentHash(content)) return;
    this.append({ operationId: crypto.randomUUID(), path, content });
  }
  rename(path: string, newPath: string): Promise<void> {
    this.stageRename(path, newPath);
    return this.retry();
  }
  stageRename(path: string, newPath: string): void { this.append({ operationId: crypto.randomUUID(), path, newPath }); }
  stageDelete(path: string): void { this.append({ operationId: crypto.randomUUID(), path, content: null }); }
  /** Explicit user decision only. Never automatically overwrite a conflicting note. */
  async resolveWithLocal(content: string): Promise<void> {
    const superseded = new Set(this.jobs.slice(1));
    const result = this.tail.then(async () => {
    const job = this.conflict;
    if (!job || job !== this.jobs[0] || job.newPath || job.content === null) throw new Error('This conflict needs manual path reconciliation');
    if (this.jobs.slice(1).some(next => (next.path === job.path || next.newPath === job.path) && (next.newPath || next.content === null))) {
      throw new Error('Pending path changes require manual reconciliation before replacing content');
    }
    const manifest = await this.client.request<{ notes: RemoteNote[] }>('/notes');
    const remote = manifest.notes.find(note => note.path === job.path);
    // A new decision gets a NEW ID; the old sent payload is never reused.
    this.jobs = [{ operationId: crypto.randomUUID(), path: job.path, content,
      expectedRevision: remote?.revision ?? 0, hash: await contentHash(content) },
      ...this.jobs.slice(1).filter(next => next.path !== job.path || !superseded.has(next))];
    this.save(); this.conflict = null;
    });
    this.tail = result.catch(() => {});
    await result;
    await this.retry();
  }
  retry(): Promise<void> {
    const result = this.tail.then(async () => {
      while (this.jobs.length) {
        const job = this.jobs[0];
        this.assertOpen();
        this.activeJob = job;
        try { await this.apply(job); }
        catch (error) { if (error instanceof RemoteError && error.status === 409) this.conflict = job; throw error; }
        finally { this.activeJob = null; }
        this.jobs.shift(); this.save();
        this.conflict = null;
      }
    });
    this.tail = result.catch(() => {});
    return result;
  }
  private async apply(job: NoteJob): Promise<void> {
    if (job.expectedRevision === undefined) {
      const known = this.state[job.path];
      if (job.newPath) {
        if (!known) throw new Error(`${job.path}: reconcile the original path before renaming`);
        job.hash = known.hash;
        job.expectedRevision = known.revision;
      } else {
        const hash = job.content === null ? null : await contentHash(job.content!);
        if (known?.hash === hash) return;
        let remote: RemoteNote | undefined;
        if (!known) {
          const manifest = await this.client.request<{ notes: RemoteNote[] }>('/notes');
          remote = manifest.notes.find(n => n.path === job.path);
          if (remote) {
            if (remote.hash !== hash) throw new RemoteError(409, `${job.path}: content differs from the backend; publication paused for reconciliation`);
            this.assertOpen();
            this.state[job.path] = { revision: remote.revision, hash };
            this.persist(this.state); return;
          }
          if (job.content === null) return;
        }
        job.hash = hash;
        job.expectedRevision = known?.revision ?? 0;
      }
    }
    this.assertOpen();
    this.save(); // Durable immutable payload before the network call.
    if (job.newPath) {
      const result = await this.client.request<{ revision: number; newRevision: number }>('/notes/rename', {
        operationId: job.operationId, path: job.path, newPath: job.newPath, expectedRevision: job.expectedRevision,
      });
      this.assertOpen();
      this.state[job.newPath] = { revision: result.newRevision, hash: job.hash! };
      this.state[job.path] = { revision: result.revision, hash: null };
    } else {
      const result = await this.client.request<{ revision: number }>('/notes', {
        operationId: job.operationId, path: job.path, content: job.content, expectedRevision: job.expectedRevision,
      });
      this.assertOpen();
      this.state[job.path] = { revision: result.revision, hash: job.hash! };
    }
    this.persist(this.state); // Before dequeue; replaying a receipt is safe.
  }
}
