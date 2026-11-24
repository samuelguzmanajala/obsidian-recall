import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { RecallDatabase } from '../../../src/server/database';
import { RecallService } from '../../../src/server/service';
import { readInternalMcpConfig } from '../../../src/server/mcp/config';
import { createInternalServer } from '../../../src/server/mcp/internal-server';
import { createPublicServer } from '../../../src/server/mcp/public-server';
import { OAuthStore } from '../../../src/server/mcp/oauth-store';
import { RECALL_TOOLS } from '../../../src/server/mcp/tools';
import { mcpTools } from '../../../src/server/mcp/configure';

const SECRET = 'internal-secret-'.repeat(3);
const OWNER = 'owner-secret-'.repeat(4);
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

async function service() {
  const db = new RecallDatabase(':memory:');
  cleanup.push(() => db.close());
  const s = new RecallService(db, { shuffleReviews: false, dailyNewLimit: 0 });
  await s.note({ operationId: randomUUID(), path: 'Spanish.md', content: '#spanish\nhola::hello', expectedRevision: 0 });
  return s;
}
async function listen(server: ReturnType<typeof createInternalServer>) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function serve(write = false) {
  return listen(createInternalServer(await service(), { secret: SECRET, tools: mcpTools(write) }));
}
const rpc = (base: string, auth: string | undefined, message: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/mcp`, { method: 'POST', body: JSON.stringify(message), headers: {
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(auth ? { Authorization: auth } : {}), ...headers } });
const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
/** Raw request with an arbitrary Host header (fetch does not let you set it). */
function withHost(base: string, host: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}/mcp`, { method: 'POST', headers: { host, authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' } },
      res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end(JSON.stringify(list));
  });
}

describe('internal MCP listener (for the local gateway)', () => {
  it('serves MCP with the shared secret: initialize, tools/list, tools/call', async () => {
    const base = await serve();
    const auth = `Bearer ${SECRET}`;
    const init = await (await rpc(base, auth, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mcp-hub', version: '1' } } })).json();
    expect(init.result).toMatchObject({ protocolVersion: '2025-11-25', serverInfo: { name: 'recall' } });
    expect(init.result.instructions).toContain('Recall is the user');
    const tools = await (await rpc(base, auth, list)).json();
    expect(tools.result.tools.map((t: { name: string }) => t.name)).toEqual(RECALL_TOOLS.map(t => t.name));
    const call = await (await rpc(base, auth, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_decks', arguments: {} } })).json();
    expect(call.result.isError).toBeUndefined();
  });
  it('exposes the write tools only with RECALL_MCP_WRITE, like the public listener', async () => {
    const base = await serve(true);
    const tools = await (await rpc(base, `Bearer ${SECRET}`, list)).json();
    expect(tools.result.tools.length).toBeGreaterThan(RECALL_TOOLS.length);
    expect(tools.result.tools.map((t: { name: string }) => t.name)).toContain('record_review');
  });
  it('refuses a missing or wrong secret', async () => {
    const base = await serve();
    for (const auth of [undefined, 'Bearer wrong', `Basic ${SECRET}`, `Bearer ${SECRET}x`]) {
      const res = await rpc(base, auth, list);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
    }
  });
  it('refuses any Origin and non-loopback Host headers (DNS rebinding), even with the secret', async () => {
    const base = await serve();
    expect((await rpc(base, `Bearer ${SECRET}`, list, { Origin: 'http://127.0.0.1' })).status).toBe(403);
    expect(await withHost(base, 'evil.example')).toBe(403);
    expect(await withHost(base, 'evil.example:27126')).toBe(403);
    expect(await withHost(base, 'localhost:27126')).toBe(200);
  });
  it('serves only /mcp: no OAuth routes, no metadata, no private API', async () => {
    const base = await serve();
    for (const path of ['/.well-known/oauth-authorization-server', '/oauth/register', '/api/v1/decks', '/']) {
      expect((await fetch(base + path, { headers: { Authorization: `Bearer ${SECRET}` } })).status).toBe(404);
    }
  });
  it('the secret is not an OAuth token: the public listener rejects it', async () => {
    const store = new OAuthStore(':memory:');
    cleanup.push(() => store.close());
    const issuer = 'https://recall.example.ts.net';
    const base = await listen(createPublicServer(await service(), store, { issuer, resource: `${issuer}/mcp`, ownerToken: OWNER, failedApprovalDelayMs: 0 }));
    expect((await rpc(base, `Bearer ${SECRET}`, list)).status).toBe(401);
  });
  it('refuses a short secret', async () => {
    expect(() => createInternalServer({} as RecallService, { secret: 'short', tools: [] })).toThrow(/at least 32/);
  });
});

describe('readInternalMcpConfig', () => {
  it('is disabled unless both settings are present', () => {
    expect(readInternalMcpConfig({})).toBeUndefined();
    expect(() => readInternalMcpConfig({ RECALL_MCP_INTERNAL_PORT: '27126' })).toThrow();
    expect(() => readInternalMcpConfig({ RECALL_MCP_INTERNAL_SECRET: SECRET })).toThrow();
  });
  it('reads port, secret and the shared write switch', () => {
    expect(readInternalMcpConfig({ RECALL_MCP_INTERNAL_PORT: '27126', RECALL_MCP_INTERNAL_SECRET: SECRET, RECALL_MCP_WRITE: 'true' }))
      .toEqual({ port: 27126, secret: SECRET, write: true });
  });
  it('rejects clashing ports, bad ports and short secrets', () => {
    const ok = { RECALL_MCP_INTERNAL_PORT: '27126', RECALL_MCP_INTERNAL_SECRET: SECRET };
    expect(() => readInternalMcpConfig({ ...ok, RECALL_MCP_INTERNAL_PORT: '27124' })).toThrow(/differ/);
    expect(() => readInternalMcpConfig({ ...ok, RECALL_MCP_PORT: '27126' })).toThrow(/differ/);
    expect(() => readInternalMcpConfig({ ...ok, RECALL_MCP_INTERNAL_PORT: 'x' })).toThrow(/Invalid/);
    expect(() => readInternalMcpConfig({ ...ok, RECALL_MCP_INTERNAL_SECRET: 'short' })).toThrow(/32/);
  });
});
