import { RemoteClient, RemoteError, type RemoteNote } from './remote-client';

type Acknowledged = Record<string, { revision: number; hash: string | null }>;
export type NoteJob = {
  operationId: string; path: string; content?: string | null; newPath?: string;
  expectedRevision?: number; hash?: string | null; baseHash?: string | null;
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
  private replaceJobs(next: NoteJob[]): void {
    const previous = this.jobs;
    this.jobs = next;
    try { this.save(); } catch (error) { this.jobs = previous; throw error; }
  }
  private remember(path: string, revision: number, hash: string | null): void {
    // An old idempotency receipt must not move an acknowledged cursor backwards.
    if ((this.state[path]?.revision ?? -1) <= revision) this.state[path] = { revision, hash };
  }
  private append(job: NoteJob): void {
    this.assertOpen();
    const last = this.jobs.at(-1);
    // Never replace a payload once it has been prepared for sending.
    if (last && last !== this.activeJob && !last.newPath && !job.newPath && last.path === job.path
      && typeof last.content === 'string' && typeof job.content === 'string' && last.expectedRevision === undefined) {
      last.content = job.content;
    } else this.jobs.push(job);
    this.save();
  }
  publish(path: string, content: string | null): Promise<void> {
    this.append({ operationId: crypto.randomUUID(), path, content });
    return this.retry(path);
  }
  async stageCurrent(path: string, content: string): Promise<void> {
    if (!this.jobs.some(job => job.path === path || job.newPath === path)
      && this.state[path]?.hash === await contentHash(content)) return;
    this.append({ operationId: crypto.randomUUID(), path, content });
  }
  rename(path: string, newPath: string): Promise<void> {
    this.stageRename(path, newPath);
    return this.retry(path);
  }
  stageRename(path: string, newPath: string): void { this.append({ operationId: crypto.randomUUID(), path, newPath }); }
  stageDelete(path: string): void { this.append({ operationId: crypto.randomUUID(), path, content: null }); }
  /** Explicit user decision only. Never automatically overwrite a conflicting note. */
  async resolveWithLocal(content: string, expectedPath?: string): Promise<void> {
    const superseded = new Set(this.jobs.slice(1));
    const result = this.tail.then(async () => {
    const job = this.conflict;
    if (!job || !this.jobs.includes(job) || job.newPath || job.content === null || (expectedPath && job.path !== expectedPath)) throw new Error('This conflict needs manual path reconciliation');
    const index = this.jobs.indexOf(job);
    if (this.jobs.slice(index + 1).some(next => (next.path === job.path || next.newPath === job.path) && (next.newPath || next.content === null))) {
      throw new Error('Pending path changes require manual reconciliation before replacing content');
    }
    const manifest = await this.client.request<{ notes: RemoteNote[] }>('/notes');
    const remote = manifest.notes.find(note => note.path === job.path);
    // A new decision gets a NEW ID; the old sent payload is never reused.
    this.replaceJobs([...this.jobs.slice(0, index), { operationId: crypto.randomUUID(), path: job.path, content,
      expectedRevision: remote?.revision ?? 0, baseHash: remote?.hash ?? null, hash: await contentHash(content) },
      ...this.jobs.slice(index + 1).filter(next => next.path !== job.path || !superseded.has(next))]);
    this.conflict = null;
    });
    this.tail = result.catch(() => {});
    await result;
    await this.retry();
  }
  retry(reportPath?: string): Promise<void> {
    const result = this.tail.then(async () => {
      const blocked = new Set<string>();
      let reportedError: Error | null = null;
      this.conflict = null;
      for (let index = 0; index < this.jobs.length;) {
        const job = this.jobs[index];
        const paths = job.newPath ? [job.path, job.newPath] : [job.path];
        if (paths.some(path => blocked.has(path))) {
          paths.forEach(path => blocked.add(path));
          if (reportPath && paths.includes(reportPath)) reportedError ??= new RemoteError(409, `${reportPath}: depende de un conflicto de nota o de ruta`);
          index++; continue;
        }
        this.assertOpen();
        this.activeJob = job;
        try {
          try { await this.apply(job); }
          catch (error) {
            if (!(error instanceof RemoteError) || error.status !== 409) throw error;
            if (await this.reconcileConflict(job)) continue;
            this.conflict ??= job;
            paths.forEach(path => blocked.add(path));
            if (!reportPath || paths.includes(reportPath)) reportedError ??= new RemoteError(409, `${job.path}: conflicto de contenido; las notas independientes siguen publicandose`);
            index++; continue;
          }
          this.replaceJobs(this.jobs.filter(pending => pending !== job));
        }
        finally { this.activeJob = null; }
      }
      if (reportedError) throw reportedError;
    });
    this.tail = result.catch(() => {});
    return result;
  }
  private async reconcileConflict(job: NoteJob): Promise<boolean> {
    // Do not compact across deletes or renames: these are ordering barriers.
    if (job.newPath || typeof job.content !== 'string') return false;
    const related = this.jobs.filter(next => next.path === job.path || next.newPath === job.path);
    if (related.some(next => next.newPath || typeof next.content !== 'string')) return false;
    const snapshot = related.map(ref => ({ ref, content: ref.content }));
    const manifest = await this.client.request<{ notes: RemoteNote[] }>('/notes');
    const remote = manifest.notes.find(note => note.path === job.path);
    if (!remote || remote.deleted) return false;
    const latestHash = await contentHash(snapshot.at(-1)!.content!);
    this.assertOpen();
    if (snapshot.some(({ ref, content }) => !this.jobs.includes(ref) || ref.content !== content)) return false;
    if (latestHash === remote.hash) {
      // The final queued intent is already on the server. Retire only this
      // captured prefix; edits arriving during the request remain pending.
      this.remember(job.path, remote.revision, remote.hash);
      this.persist(this.state);
      const completed = new Set(snapshot.map(({ ref }) => ref));
      this.replaceJobs(this.jobs.filter(next => !completed.has(next)));
      return true;
    }
    const known = this.state[job.path];
    const baseHash = job.baseHash !== undefined ? job.baseHash
      : known && known.revision === job.expectedRevision ? known.hash : undefined;
    if (baseHash !== undefined && baseHash === remote.hash && remote.revision !== job.expectedRevision) {
      // Revision drift, but the actual base content is unchanged. Use a fresh
      // operation ID and retain CAS protection against a subsequent remote edit.
      const replacement = { ...job, operationId: crypto.randomUUID(), expectedRevision: remote.revision, baseHash };
      this.replaceJobs(this.jobs.map(next => next === job ? replacement : next));
      return true;
    }
    return false;
  }
  private async apply(job: NoteJob): Promise<void> {
    if (job.expectedRevision === undefined) {
      const known = this.state[job.path];
      if (job.newPath) {
        if (!known) throw new RemoteError(409, `${job.path}: reconcile the original path before renaming`);
        job.hash = known.hash;
        job.baseHash = known.hash;
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
        job.baseHash = known?.hash ?? null;
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
      this.remember(job.newPath, result.newRevision, job.hash!);
      this.remember(job.path, result.revision, null);
    } else {
      const result = await this.client.request<{ revision: number }>('/notes', {
        operationId: job.operationId, path: job.path, content: job.content, expectedRevision: job.expectedRevision,
      });
      this.assertOpen();
      this.remember(job.path, result.revision, job.hash!);
    }
    this.persist(this.state); // Before dequeue; replaying a receipt is safe.
  }
}
