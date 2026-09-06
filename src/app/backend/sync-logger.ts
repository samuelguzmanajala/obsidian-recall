import { App } from 'obsidian';

const LOG_PATH = 'recall-data/sync-log.txt';
/** Truncate the log when it grows past this many bytes — keeps the tail. */
const MAX_BYTES = 1_000_000;

/**
 * Append-only diagnostic log written to a file inside the vault. Used to
 * trace why study items are sometimes recreated/lost during vault-sync —
 * a question that needs ground-truth event ordering, not console.log
 * noise that disappears when DevTools closes.
 *
 * Writes are best-effort and async — they never throw and never block the
 * caller. If the vault adapter fails (rare), the line is dropped silently.
 */
export class SyncLogger {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly app: App) {}

  info(message: string): void { this.append('INFO', message); }
  warn(message: string): void { this.append('WARN', message); }

  private append(level: string, message: string): void {
    const line = `${new Date().toISOString()}  ${level.padEnd(4)}  ${message}\n`;
    // Chain on the queue so concurrent appends serialize and don't clobber each other
    this.writeQueue = this.writeQueue.then(() => this.appendToFile(line)).catch(() => { /* swallow */ });
  }

  private async appendToFile(line: string): Promise<void> {
    try {
      let existing = '';
      try {
        existing = await this.app.vault.adapter.read(LOG_PATH);
      } catch { /* file doesn't exist yet */ }

      // Rotate (keep the latter half) once we cross the size cap
      if (existing.length > MAX_BYTES) {
        const halfPoint = Math.floor(existing.length / 2);
        const cutAt = existing.indexOf('\n', halfPoint) + 1;
        existing = `--- log truncated at ${new Date().toISOString()} ---\n` +
          existing.slice(cutAt);
      }

      try { await this.app.vault.adapter.mkdir('recall-data'); } catch { /* exists */ }
      await this.app.vault.adapter.write(LOG_PATH, existing + line);
    } catch {
      // swallow — logging must never break the host operation
    }
  }
}
