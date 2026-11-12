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
  return {
    port: n,
    host: env.RECALL_MCP_HOST ?? '127.0.0.1',
    issuer: url.origin,
    resource: `${url.origin}/mcp`,
    oauthDb: resolve(env.RECALL_MCP_OAUTH_DB ?? join(dirname(recallDb), 'recall-oauth.sqlite')),
  };
}
