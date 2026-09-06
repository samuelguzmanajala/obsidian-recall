import { describe, expect, it, vi } from 'vitest';
import { LiveRefresh } from '../../../src/app/frontend/live-refresh';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('LiveRefresh', () => {
  it('serializes and coalesces a burst into one follow-up', async () => {
    const gate = deferred();
    const work = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue(undefined);
    const live = new LiveRefresh(work);
    const pending = live.request();
    await Promise.resolve();
    for (let i = 0; i < 10; i++) void live.request();
    expect(work).toHaveBeenCalledTimes(1);
    gate.resolve();
    await pending;
    expect(work).toHaveBeenCalledTimes(2);
  });
  it('invalidates responses arriving after a mutation', async () => {
    const gate = deferred();
    let applied = false;
    const live = new LiveRefresh(async current => { await gate.promise; applied = current(); });
    const pending = live.request();
    await Promise.resolve();
    live.invalidate(); gate.resolve(); await pending;
    expect(applied).toBe(false);
  });
  it('does not publish or run queued work after close', async () => {
    const gate = deferred();
    let applied = false;
    const work = vi.fn(async (current: () => boolean) => { await gate.promise; applied = current(); });
    const live = new LiveRefresh(work);
    const pending = live.request(); await Promise.resolve();
    void live.request(); live.close(); gate.resolve(); await pending; await live.request();
    expect(applied).toBe(false); expect(work).toHaveBeenCalledTimes(1);
  });
});
