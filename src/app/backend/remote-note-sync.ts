import { RemoteClient, RemoteError, type RemoteNote } from './remote-client';

type Acknowledged = Record<string, { revision: number; hash: string | null }>;
export async function contentHash(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Publishes Markdown, never scheduling files. Cursors are device-local, not vault-synced. */
export class RemoteNoteSync {
  private tail: Promise<unknown> = Promise.resolve();
  private manifest: Map<string, RemoteNote> | null = null;
  constructor(private client: RemoteClient, private state: Acknowledged,
    private persist: (state: Acknowledged) => void) {}
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }
  publish(path: string, content: string | null): Promise<void> {
    return this.enqueue(async () => {
      const hash = content === null ? null : await contentHash(content);
      const known = this.state[path];
      if (known && known.hash === hash) return;
      let expectedRevision = known?.revision ?? 0;
      if (!known) {
        if (!this.manifest) {
          const manifest = await this.client.request<{ notes: RemoteNote[] }>('/notes');
          this.manifest = new Map(manifest.notes.map(n => [n.path, n]));
        }
        const remote = this.manifest.get(path);
        if (remote) {
          if (remote.hash !== hash) throw new RemoteError(409, `${path}: content differs from the backend; reconcile it before publishing`);
          this.state[path] = { revision: remote.revision, hash };
          this.persist(this.state); return;
        }
        if (content === null) return;
        expectedRevision = 0;
      }
      const result = await this.client.request<{ revision: number }>('/notes', {
        operationId: crypto.randomUUID(), path, content, expectedRevision,
      });
      this.state[path] = { revision: result.revision, hash };
      this.persist(this.state);
    });
  }
  rename(path: string, newPath: string): Promise<void> {
    return this.enqueue(async () => {
      const known = this.state[path];
      if (!known) throw new Error(`${path}: publish/reconcile the original path before renaming`);
      const result = await this.client.request<{ revision: number; newRevision: number }>('/notes/rename', {
        operationId: crypto.randomUUID(), path, newPath, expectedRevision: known.revision,
      });
      this.state[newPath] = { revision: result.newRevision, hash: known.hash };
      this.state[path] = { revision: result.revision, hash: null };
      this.persist(this.state);
    });
  }
}
