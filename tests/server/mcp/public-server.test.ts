import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecallDatabase } from '../../../src/server/database';
import { RecallService } from '../../../src/server/service';
import { createPublicServer } from '../../../src/server/mcp/public-server';
import { OAuthStore } from '../../../src/server/mcp/oauth-store';
import { ACCESS_TOKEN_TTL_MS, MAX_UNAPPROVED_CLIENTS } from '../../../src/server/mcp/oauth';
import { RECALL_TOOLS } from '../../../src/server/mcp/tools';

const OWNER = 'owner-secret-'.repeat(4);
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

async function serve(options: { storePath?: string; store?: OAuthStore; issuer?: string; now?: () => number;
  failedApprovalDelayMs?: number; log?: (line: string) => void } = {}) {
  const db = new RecallDatabase(':memory:');
  cleanup.push(() => db.close());
  const service = new RecallService(db, { shuffleReviews: false, dailyNewLimit: 0 });
  await service.note({ operationId: randomUUID(), path: 'Spanish.md', content: '#spanish\nhola::hello\nadiós::goodbye', expectedRevision: 0 });
  let store = options.store;
  if (!store) {
    const owned = store = new OAuthStore(options.storePath ?? ':memory:');
    cleanup.push(() => owned.close());
  }
  // The issuer is the public URL; the test talks to the loopback port behind it, like Funnel would.
  const issuer = options.issuer ?? 'https://recall.example.ts.net:10000';
  const server = createPublicServer(service, store, { issuer, resource: `${issuer}/mcp`, ownerToken: OWNER, now: options.now,
    failedApprovalDelayMs: options.failedApprovalDelayMs ?? 0, log: options.log });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, issuer, service, store };
}
const form = (fields: Record<string, string>) => ({
  method: 'POST', redirect: 'manual' as const, body: new URLSearchParams(fields).toString(),
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
});
async function register(base: string, extra: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...extra }) });
  expect(res.status).toBe(201);
  return await res.json() as Record<string, string>;
}
function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}
function authorizeParams(clientId: string, challenge: string, issuer: string, extra: Record<string, string> = {}) {
  return { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 'xyz', code_challenge: challenge,
    code_challenge_method: 'S256', scope: 'recall', resource: `${issuer}/mcp`, ...extra };
}
async function approve(base: string, params: Record<string, string>, ownerToken = OWNER) {
  return fetch(`${base}/oauth/authorize`, form({ ...params, owner_token: ownerToken, decision: 'approve' }));
}
async function obtainCode(base: string, issuer: string) {
  const client = await register(base);
  const { verifier, challenge } = pkce();
  const res = await approve(base, authorizeParams(client.client_id, challenge, issuer));
  expect(res.status).toBe(303);
  const location = new URL(res.headers.get('location')!);
  return { client, verifier, code: location.searchParams.get('code')!, location };
}
async function exchange(base: string, fields: Record<string, string>) {
  const res = await fetch(`${base}/oauth/token`, form(fields));
  return { status: res.status, body: await res.json() as Record<string, any> };
}
async function login(base: string, issuer: string) {
  const { client, verifier, code } = await obtainCode(base, issuer);
  const { status, body } = await exchange(base, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT,
    code_verifier: verifier, client_id: client.client_id, resource: `${issuer}/mcp` });
  expect(status).toBe(200);
  return { client, tokens: body };
}
async function rpc(base: string, token: string | undefined, message: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/mcp`, { method: 'POST', body: JSON.stringify(message), headers: {
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });
}

describe('public MCP listener: discovery', () => {
  it('publishes protected-resource and authorization-server metadata at the origin root', async () => {
    const { base, issuer } = await serve();
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const res = await fetch(base + path);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ resource: `${issuer}/mcp`, authorization_servers: [issuer], scopes_supported: ['recall'] });
    }
    const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(meta).toMatchObject({
      issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`, code_challenge_methods_supported: ['S256'],
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      authorization_response_iss_parameter_supported: true,
    });
    expect(meta.token_endpoint_auth_methods_supported).toContain('none');
  });
  it('answers 401 with a WWW-Authenticate pointer to the resource metadata', async () => {
    const { base, issuer } = await serve();
    const missing = await rpc(base, undefined, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="recall"`);
    const invalid = await rpc(base, 'not-a-token', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get('www-authenticate')).toMatch(/resource_metadata=".*", scope="recall", error="invalid_token"/);
  });
});

describe('public MCP listener: client registration', () => {
  it('registers public and confidential clients', async () => {
    const { base } = await serve();
    const pub = await register(base);
    expect(pub).toMatchObject({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', client_name: 'ChatGPT' });
    expect(pub.client_secret).toBeUndefined();
    const confidential = await register(base, { token_endpoint_auth_method: 'client_secret_post' });
    expect(confidential.client_secret).toMatch(/^[\w-]{43}$/);
  });
  it('rejects invalid redirect URIs and metadata', async () => {
    const { base } = await serve();
    const post = (body: unknown) => fetch(`${base}/oauth/register`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    for (const redirect_uris of [[], ['http://evil.example/cb'], ['https://x.example/cb#frag'], ['not a url']]) {
      const res = await post({ redirect_uris });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid_redirect_uri');
    }
    expect((await post({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'private_key_jwt' })).status).toBe(400);
    expect((await post({ redirect_uris: [REDIRECT], grant_types: ['client_credentials'] })).status).toBe(400);
  });
  it('never fills up: the oldest never-approved clients make room, approved clients stay', async () => {
    let now = Date.now();
    const { base, issuer, store } = await serve({ now: () => now });
    const { client: owned } = await login(base, issuer); // approved by the owner
    const strangers = [];
    for (let i = 0; i < MAX_UNAPPROVED_CLIENTS + 20; i++) { now += 1; strangers.push((await register(base)).client_id); }
    expect(store.countClients()).toBe(MAX_UNAPPROVED_CLIENTS + 1);
    expect(store.findClient(strangers[19])).toBeUndefined();
    expect(store.findClient(strangers[20])).toBeDefined();
    expect(store.findClient(owned.client_id)).toBeDefined();
    // The owner can still register and approve a new client right away.
    now += 1;
    const fresh = await register(base);
    expect(store.findClient(strangers[20])).toBeUndefined();
    expect((await approve(base, authorizeParams(fresh.client_id, pkce().challenge, issuer))).status).toBe(303);
    // An evicted client is unknown: the approval page tells the owner to add the connector again.
    const evicted = await fetch(`${base}/oauth/authorize?${new URLSearchParams(authorizeParams(strangers[0], pkce().challenge, issuer))}`);
    expect(evicted.status).toBe(400);
    expect(await evicted.text()).toContain('Unknown client');
  });
});

describe('public MCP listener: authorization code + PKCE', () => {
  it('shows the approval page, then redirects with code, state and iss', async () => {
    const { base, issuer } = await serve();
    const client = await register(base);
    const { challenge } = pkce();
    const page = await fetch(`${base}/oauth/authorize?${new URLSearchParams(authorizeParams(client.client_id, challenge, issuer))}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const html = await page.text();
    expect(html).toContain('name="owner_token"');
    expect(html).toContain('ChatGPT');
    expect(html).not.toContain(OWNER);
    const { location } = await obtainCode(base, issuer);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get('state')).toBe('xyz');
    expect(location.searchParams.get('iss')).toBe(issuer);
    expect(location.searchParams.get('code')).toMatch(/^[\w-]{43}$/);
  });
  it('issues tokens for the right verifier and rotates refresh tokens', async () => {
    const { base, issuer } = await serve();
    const { client, tokens } = await login(base, issuer);
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_MS / 1000, scope: 'recall' });
    expect(tokens.refresh_token).toBeTruthy();
    const refreshed = await exchange(base, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(tokens.refresh_token);
    expect((await rpc(base, refreshed.body.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200);
    // Replaying the rotated refresh token revokes the whole grant.
    expect((await exchange(base, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).body.error).toBe('invalid_grant');
    expect((await rpc(base, refreshed.body.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
    expect((await exchange(base, { grant_type: 'refresh_token', refresh_token: refreshed.body.refresh_token, client_id: client.client_id })).status).toBe(400);
  });
  it('answers a wrong owner token after a delay, and failures never lock the owner out', async () => {
    const delay = 150;
    const { base, issuer } = await serve({ failedApprovalDelayMs: delay });
    const client = await register(base);
    const params = authorizeParams(client.client_id, pkce().challenge, issuer);
    let start = performance.now();
    const wrong = await approve(base, params, 'x'.repeat(OWNER.length));
    expect(performance.now() - start).toBeGreaterThanOrEqual(delay - 5);
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('location')).toBeNull();
    expect(await wrong.text()).toContain('Wrong token');
    // A stranger hammering the page (all requests come from the same local proxy behind Funnel)...
    const flood = Array.from({ length: 30 }, () => approve(base, params, 'guess'));
    // ...does not delay or block the owner, even while the failures are still pending.
    start = performance.now();
    expect((await approve(base, params)).status).toBe(303);
    expect(performance.now() - start).toBeLessThan(delay);
    expect((await Promise.all(flood)).map(r => r.status)).toEqual(Array(30).fill(401));
    expect((await approve(base, params)).status).toBe(303);
  });
  it('never redirects to an unregistered redirect URI', async () => {
    const { base, issuer } = await serve();
    const client = await register(base);
    const params = authorizeParams(client.client_id, pkce().challenge, issuer, { redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect/evil' });
    const page = await fetch(`${base}/oauth/authorize?${new URLSearchParams(params)}`, { redirect: 'manual' });
    expect(page.status).toBe(400);
    expect(page.headers.get('location')).toBeNull();
    const post = await approve(base, params);
    expect(post.status).toBe(400);
    expect(post.headers.get('location')).toBeNull();
    const unknown = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ ...params, client_id: 'nope', redirect_uri: REDIRECT })}`, { redirect: 'manual' });
    expect(unknown.status).toBe(400);
  });
  it('redirects protocol errors back to the client with iss', async () => {
    const { base, issuer } = await serve();
    const client = await register(base);
    const check = async (extra: Record<string, string>, error: string) => {
      const res = await fetch(`${base}/oauth/authorize?${new URLSearchParams(authorizeParams(client.client_id, pkce().challenge, issuer, extra))}`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('location')!);
      expect(location.searchParams.get('error')).toBe(error);
      expect(location.searchParams.get('iss')).toBe(issuer);
      expect(location.searchParams.get('state')).toBe('xyz');
    };
    await check({ code_challenge_method: 'plain' }, 'invalid_request');
    await check({ response_type: 'token' }, 'unsupported_response_type');
    await check({ resource: 'https://other.example/mcp' }, 'invalid_target');
    const denied = await fetch(`${base}/oauth/authorize`, form({ ...authorizeParams(client.client_id, pkce().challenge, issuer), decision: 'deny' }));
    expect(new URL(denied.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
  });
  it('rejects a wrong verifier, a wrong redirect URI, another client and a reused code', async () => {
    const { base, issuer } = await serve();
    const exchangeWith = async (overrides: Record<string, string>) => {
      const { client, verifier, code } = await obtainCode(base, issuer);
      return exchange(base, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: client.client_id, ...overrides });
    };
    expect((await exchangeWith({ code_verifier: pkce().verifier })).body.error).toBe('invalid_grant');
    expect((await exchangeWith({ redirect_uri: 'https://chatgpt.com/other' })).body.error).toBe('invalid_grant');
    expect((await exchangeWith({ client_id: (await register(base)).client_id })).body.error).toBe('invalid_grant');
    expect((await exchangeWith({ resource: 'https://other.example/mcp' })).body.error).toBe('invalid_target');
    expect((await exchangeWith({ client_id: 'unknown' })).status).toBe(401);

    const { client, verifier, code } = await obtainCode(base, issuer);
    const fields = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: client.client_id };
    const first = await exchange(base, fields);
    expect(first.status).toBe(200);
    const reused = await exchange(base, fields);
    expect(reused.body.error).toBe('invalid_grant');
    // The replay revokes what the code had issued.
    expect((await rpc(base, first.body.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
  });
  it('a failed exchange still consumes the code', async () => {
    const { base, issuer } = await serve();
    const { client, verifier, code } = await obtainCode(base, issuer);
    const fields = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: client.client_id };
    expect((await exchange(base, { ...fields, code_verifier: pkce().verifier })).status).toBe(400);
    expect((await exchange(base, { ...fields, code_verifier: verifier })).body.error).toBe('invalid_grant');
  });
  it('expires codes and access tokens', async () => {
    let now = Date.now();
    const { base, issuer } = await serve({ now: () => now });
    const { client, verifier, code } = await obtainCode(base, issuer);
    now += 61_000;
    expect((await exchange(base, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: client.client_id })).body.error).toBe('invalid_grant');
    const { tokens } = await login(base, issuer);
    now += ACCESS_TOKEN_TTL_MS + 1;
    expect((await rpc(base, tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
  });
  it('authenticates confidential clients', async () => {
    const { base, issuer } = await serve();
    const client = await register(base, { token_endpoint_auth_method: 'client_secret_basic' });
    const { verifier, challenge } = pkce();
    const code = new URL((await approve(base, authorizeParams(client.client_id, challenge, issuer))).headers.get('location')!).searchParams.get('code')!;
    const fields = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier };
    const basic = (secret: string) => `Basic ${Buffer.from(`${client.client_id}:${secret}`).toString('base64')}`;
    const bad = await fetch(`${base}/oauth/token`, { ...form(fields), headers: { ...form(fields).headers, Authorization: basic('wrong') } });
    expect(bad.status).toBe(401);
    const good = await fetch(`${base}/oauth/token`, { ...form(fields), headers: { ...form(fields).headers, Authorization: basic(client.client_secret) } });
    expect(good.status).toBe(200);
  });
  it('keeps clients and tokens across a restart, storing only token hashes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recall-oauth-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const storePath = join(dir, 'recall-oauth.sqlite');
    const first = await serve({ storePath });
    const { client, tokens } = await login(first.base, first.issuer);
    for (const f of cleanup.splice(1).reverse()) await f(); // stop the first server and close its store, keep the temp dir
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(storePath);
    const dump = JSON.stringify(raw.prepare('SELECT * FROM oauth_tokens').all());
    raw.close();
    expect(dump).not.toContain(tokens.access_token);
    expect(dump).not.toContain(tokens.refresh_token);
    const second = await serve({ storePath });
    expect((await rpc(second.base, tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200);
    expect((await exchange(second.base, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).status).toBe(200);
  });
});

describe('public MCP listener: MCP over Streamable HTTP', () => {
  it('runs initialize → tools/list → tools/call with a valid token', async () => {
    const { base, issuer, service } = await serve();
    const { tokens } = await login(base, issuer);
    const token = tokens.access_token;
    const init = await rpc(base, token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    expect(init.status).toBe(200);
    expect(init.headers.get('content-type')).toMatch(/^application\/json/);
    expect(init.headers.get('mcp-session-id')).toBeNull();
    expect(await init.json()).toMatchObject({ jsonrpc: '2.0', id: 1, result: {
      protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'recall' } } });
    const v = { 'MCP-Protocol-Version': '2025-06-18' };
    const initialized = await rpc(base, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, v);
    expect(initialized.status).toBe(202);
    expect(await initialized.text()).toBe('');

    const list = await (await rpc(base, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, v)).json();
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(RECALL_TOOLS.map(t => t.name));
    for (const t of list.result.tools) {
      expect(t).toMatchObject({ inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } });
    }

    const call = await (await rpc(base, token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_decks', arguments: {} } }, v)).json();
    const expected = await service.query(async c => ({ decks: await c.getDeckTree.execute() }));
    expect(call.result.isError).toBeUndefined();
    expect(call.result.structuredContent).toEqual(expected);
    expect(JSON.parse(call.result.content[0].text)).toEqual(expected);
    expect(expected.decks.length).toBeGreaterThan(0);

    // Bad tool input is a tool execution error the model can read and correct, not a protocol error.
    const bad = await (await rpc(base, token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_due_cards', arguments: { limit: 500 } } }, v)).json();
    expect(bad.error).toBeUndefined();
    expect(bad.result).toEqual({ content: [{ type: 'text', text: 'limit must be an integer from 1 to 50' }], isError: true });
    const due = await (await rpc(base, token, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_due_cards', arguments: { limit: 1 } } }, v)).json();
    expect(due.result.structuredContent.cards).toEqual([expect.objectContaining({ prompt: 'hola', answer: 'hello', state: 'new' })]);
  });
  it('logs one line per request, with the MCP-Protocol-Version of /mcp requests', async () => {
    const lines: string[] = [];
    const { base, issuer } = await serve({ log: line => lines.push(line) });
    const { tokens } = await login(base, issuer);
    lines.length = 0;
    await rpc(base, tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': '2026-07-28', 'User-Agent': 'probe "x"' });
    await rpc(base, tokens.access_token, { jsonrpc: '2.0', id: 2, method: 'ping' });
    await fetch(`${base}/.well-known/oauth-authorization-server`);
    await new Promise(r => setTimeout(r, 20));
    expect(lines[0]).toMatch(/^\[Recall MCP\] \S+ POST \/mcp 400 "probe 'x'" mcp-protocol-version=2026-07-28$/);
    expect(lines[1]).toMatch(/ POST \/mcp 200 "\S+" mcp-protocol-version=-$/);
    expect(lines[2]).toMatch(/ GET \/.well-known\/oauth-authorization-server 200 "\S+"$/);
  });
  it('negotiates unknown versions down and rejects bad requests', async () => {
    const { base, issuer } = await serve();
    const { tokens } = await login(base, issuer);
    const t = tokens.access_token;
    const init = await (await rpc(base, t, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).json();
    expect(init.result.protocolVersion).toBe('2025-11-25');
    expect((await rpc(base, t, { jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': '1999-01-01' })).status).toBe(400);
    expect((await (await rpc(base, t, { jsonrpc: '2.0', id: 2, method: 'resources/list' })).json()).error.code).toBe(-32601);
    expect((await (await rpc(base, t, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope' } })).json()).error.code).toBe(-32602);
    expect((await (await rpc(base, t, [{ jsonrpc: '2.0', id: 4, method: 'ping' }])).json()).error.code).toBe(-32600);
    const garbage = await fetch(`${base}/mcp`, { method: 'POST', body: '{', headers: { Authorization: `Bearer ${t}` } });
    expect(garbage.status).toBe(400);
    expect((await garbage.json()).error.code).toBe(-32700);
    expect((await rpc(base, t, { jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await rpc(base, t, { jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: issuer })).status).toBe(200);
    const get = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${t}` } });
    expect(get.status).toBe(405);
  });
  it('rejects tokens issued for another resource', async () => {
    const store = new OAuthStore(':memory:');
    cleanup.push(() => store.close());
    const a = await serve({ store });
    const { tokens } = await login(a.base, a.issuer);
    expect((await rpc(a.base, tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200);
    // Same store, but a listener with another canonical resource: the token's audience does not match.
    const b = await serve({ store, issuer: 'https://other.example.ts.net' });
    expect((await rpc(b.base, tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
  });
});

describe('public MCP listener: isolation', () => {
  it('serves nothing under /api/v1, with or without credentials', async () => {
    const { base, issuer } = await serve();
    const { tokens } = await login(base, issuer);
    const paths = ['/api/v1/health', '/api/v1/decks', '/api/v1/stats', '/api/v1/leeches', '/api/v1/due', '/api/v1/notes',
      '/api/v1/note?path=Spanish.md', '/api/v1/sources', '/api/v1/audio/x/question', '/api/v1/reviews', '/api/v1/notes/rename'];
    for (const path of paths) {
      for (const auth of [undefined, `Bearer ${OWNER}`, `Bearer ${tokens.access_token}`]) {
        for (const method of ['GET', 'POST']) {
          const res = await fetch(base + path, { method, headers: auth ? { Authorization: auth } : {}, body: method === 'POST' ? '{}' : undefined });
          expect(res.status, `${method} ${path}`).toBe(404);
          expect(await res.text()).not.toMatch(/recall-backend|hola|Spanish/);
        }
      }
    }
    // The owner's RECALL_TOKEN is not an MCP access token either.
    expect((await rpc(base, OWNER, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401);
  });
});
