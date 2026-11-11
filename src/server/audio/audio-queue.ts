import { TtsDailyQuotaError } from '../../context/shared/domain/tts-client';
import type { AudioSide } from '../service';

export type GenerateSide = (studyItemId: string, side: AudioSide) => Promise<unknown>;

/**
 * In-process, best-effort generation of both sides of changed study items: one at a time,
 * de-duplicated, never awaited by the request that enqueued it. Not persistent: GET /audio
 * (on demand) and the pregeneration command cover anything dropped here.
 */
export class AudioQueue {
  private readonly pending = new Map<string, { id: string; side: AudioSide }>();
  private running = false;
  private closed = false;
  private current: Promise<void> | null = null;
  /** Set when the provider's daily quota ran out: enqueued work is dropped until then. */
  private pausedUntil = 0;

  constructor(
    private readonly generate: GenerateSide,
    private readonly options: { pauseMs?: number; now?: () => number; log?: (line: string) => void } = {},
  ) {}

  get size(): number { return this.pending.size; }

  enqueue(studyItemIds: Iterable<string>): void {
    if (this.closed || this.now() < this.pausedUntil) return;
    for (const id of studyItemIds) for (const side of ['question', 'answer'] as const) this.pending.set(`${id}:${side}`, { id, side });
    if (!this.running && this.pending.size) {
      this.running = true;
      setImmediate(() => { this.current = this.drain(); });
    }
  }

  /** Drops what is pending and waits at most `graceMs` for the side being generated. */
  async close(graceMs = 2000): Promise<void> {
    this.closed = true;
    this.pending.clear();
    if (this.current) await Promise.race([this.current, new Promise(r => setTimeout(r, graceMs).unref())]);
  }

  private async drain(): Promise<void> {
    try {
      for (const [key, { id, side }] of this.pending) {
        if (this.closed) return;
        this.pending.delete(key);
        try {
          await this.generate(id, side);
        } catch (error) {
          if (error instanceof TtsDailyQuotaError || (error as { code?: string })?.code === 'TTS_DAILY_QUOTA') {
            const dropped = this.pending.size + 1;
            this.pending.clear();
            this.pausedUntil = this.now() + (this.options.pauseMs ?? 3_600_000);
            this.log(`[Recall backend] TTS daily quota exhausted: background audio paused, ${dropped} side(s) dropped (served on demand or by the next pregeneration run)`);
            return;
          }
          this.log(`[Recall backend] background audio failed for ${id}/${side}: ${(error as Error)?.message ?? error}`);
        }
      }
    } finally {
      this.running = false;
      this.current = null;
      // Something was enqueued while the last item was being generated.
      if (this.pending.size && !this.closed) this.enqueue([]);
    }
  }

  private now(): number { return (this.options.now ?? Date.now)(); }
  private log(line: string): void { (this.options.log ?? console.error)(line); }
}
