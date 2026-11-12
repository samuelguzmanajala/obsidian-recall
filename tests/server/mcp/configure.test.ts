import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecallDatabase } from '../../../src/server/database';
import { RecallService } from '../../../src/server/service';
import { configureMcp } from '../../../src/server/mcp/configure';

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); vi.restoreAllMocks(); });

it('a port already in use on the MCP listener is reported, not thrown, so the private API keeps running', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recall-mcp-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const busy = createServer();
  await new Promise<void>(r => busy.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise(r => busy.close(r)));
  const port = (busy.address() as { port: number }).port;
  const db = new RecallDatabase(':memory:');
  cleanup.push(() => db.close());
  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
  const mcp = configureMcp({ RECALL_MCP_PORT: String(port), RECALL_MCP_PUBLIC_URL: `http://localhost:${port}`, RECALL_MCP_OAUTH_DB: join(dir, 'o.sqlite') },
    join(dir, 'recall.sqlite'), new RecallService(db), 'owner-secret-'.repeat(4))!;
  mcp.listen();
  await vi.waitFor(() => expect(errors.join('\n')).toMatch(/Recall MCP listener on 127\.0\.0\.1:\d+ failed \(EADDRINUSE\); the private API keeps running/));
  await mcp.close();
});
