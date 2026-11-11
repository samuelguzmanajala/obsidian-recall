import { afterEach, expect, it, vi } from 'vitest';
import { RemoteClient } from '../../../src/app/backend/remote-client';
import { DEFAULT_SETTINGS } from '../../../src/app/backend/plugin-settings';
afterEach(() => vi.useRealTimers());
it('times out even when the Obsidian transport cannot abort, then permits a new request', async () => {
  vi.useFakeTimers();
  const transport = vi.fn().mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  const client = new RemoteClient({ ...DEFAULT_SETTINGS, backend: { enabled: true, syncNotes: false, url: 'http://localhost:27124', token: 'test' } }, transport);
  const pending = expect(client.request('/health')).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(15_000); await pending;
  await expect(client.request('/health')).resolves.toEqual({ ok: true });
  expect(vi.getTimerCount()).toBe(0);
});
