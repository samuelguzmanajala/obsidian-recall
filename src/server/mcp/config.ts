import { dirname, join, resolve } from 'node:path';

/** Public MCP + OAuth listener, enabled only when both `RECALL_MCP_PORT` and `RECALL_MCP_PUBLIC_URL` are set. */
export interface McpConfig {
  port: number;
  host: string;
  /** Public origin (scheme, host, optional port; no path). Issuer of the authorization server. */
  issuer: string;
  /** Canonical URI of the MCP endpoint: the OAuth resource and token audience. */
  resource: string;
  /** SQLite file holding registered clients and hashed tokens, separate from the study database. */
  oauthDb: string;
  /** `RECALL_MCP_WRITE=true`: also expose the write tools (record/correct reviews, propose cards). Off by default. */
  write: boolean;
}

export function readMcpConfig(env: NodeJS.ProcessEnv, recallDb: string): McpConfig | undefined {
  const port = env.RECALL_MCP_PORT, publicUrl = env.RECALL_MCP_PUBLIC_URL;
  if (!port && !publicUrl) return undefined;
  if (!port || !publicUrl) throw new Error('Set both RECALL_MCP_PORT and RECALL_MCP_PUBLIC_URL to enable the MCP listener');
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('Invalid RECALL_MCP_PORT');
  if (n === Number(env.RECALL_PORT ?? 27124)) throw new Error('RECALL_MCP_PORT must differ from RECALL_PORT');
  let url: URL;
  try { url = new URL(publicUrl); } catch { throw new Error('Invalid RECALL_MCP_PUBLIC_URL'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('RECALL_MCP_PUBLIC_URL must use https');
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username || url.password) {
    throw new Error('RECALL_MCP_PUBLIC_URL must be an origin without path, e.g. https://host.example.ts.net:10000');
  }
  const write = env.RECALL_MCP_WRITE ?? 'false';
  if (write !== 'true' && write !== 'false') throw new Error('RECALL_MCP_WRITE must be "true" or "false"');
  return {
    write: write === 'true',
    port: n,
    host: env.RECALL_MCP_HOST ?? '127.0.0.1',
    issuer: url.origin,
    resource: `${url.origin}/mcp`,
    oauthDb: resolve(env.RECALL_MCP_OAUTH_DB ?? join(dirname(recallDb), 'recall-oauth.sqlite')),
  };
}

/** Internal MCP listener for a local gateway, enabled only when both `RECALL_MCP_INTERNAL_*` are set. Always on loopback. */
export interface InternalMcpConfig {
  port: number;
  /** Shared secret the gateway sends as a bearer token (at least 32 characters). */
  secret: string;
  /** Same switch as the public listener: `RECALL_MCP_WRITE=true` adds the write tools. */
  write: boolean;
}

export function readInternalMcpConfig(env: NodeJS.ProcessEnv): InternalMcpConfig | undefined {
  const port = env.RECALL_MCP_INTERNAL_PORT, secret = env.RECALL_MCP_INTERNAL_SECRET;
  if (!port && !secret) return undefined;
  if (!port || !secret) throw new Error('Set both RECALL_MCP_INTERNAL_PORT and RECALL_MCP_INTERNAL_SECRET to enable the internal MCP listener');
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('Invalid RECALL_MCP_INTERNAL_PORT');
  if (n === Number(env.RECALL_PORT ?? 27124) || (env.RECALL_MCP_PORT && n === Number(env.RECALL_MCP_PORT))) {
    throw new Error('RECALL_MCP_INTERNAL_PORT must differ from RECALL_PORT and RECALL_MCP_PORT');
  }
  if (secret.length < 32) throw new Error('RECALL_MCP_INTERNAL_SECRET must contain at least 32 characters');
  const write = env.RECALL_MCP_WRITE ?? 'false';
  if (write !== 'true' && write !== 'false') throw new Error('RECALL_MCP_WRITE must be "true" or "false"');
  return { port: n, secret, write: write === 'true' };
}
