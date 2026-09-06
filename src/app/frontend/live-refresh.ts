/** Coalesce overlapping refreshes and discard results after close or invalidation. */
export class LiveRefresh {
  private running: Promise<void> | null = null;
  private pending = false;
  private generation = 0;
  private closed = false;

  constructor(private work: (isCurrent: () => boolean) => Promise<void>) {}
  get stopped(): boolean { return this.closed; }

  invalidate(): void { this.generation++; }
  close(): void { this.closed = true; this.invalidate(); }

  request(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.pending = true;
    if (!this.running) {
      this.running = Promise.resolve().then(async () => {
        while (this.pending && !this.closed) {
          this.pending = false;
          const generation = this.generation;
          await this.work(() => !this.closed && generation === this.generation);
        }
      }).finally(() => { this.running = null; });
    }
    return this.running;
  }
}
