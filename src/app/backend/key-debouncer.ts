/** Per-key trailing debounce: only the last call within `delay` ms runs. */
export class KeyDebouncer {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private delay: number) {}
  schedule(key: string, run: () => void): void {
    this.cancel(key);
    this.timers.set(key, setTimeout(() => { this.timers.delete(key); run(); }, this.delay));
  }
  cancel(key: string): void { clearTimeout(this.timers.get(key)); this.timers.delete(key); }
  clear(): void { this.timers.forEach(timer => clearTimeout(timer)); this.timers.clear(); }
}
