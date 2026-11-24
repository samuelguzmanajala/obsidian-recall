import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { HttpError, createOAuthRoutes, readText, requireBearer } from '@samuelguzman/mcp-oauth';
import { sendJson } from '../send-json';
import type { RecallService } from '../service';
import { AuthorizationServer } from './oauth';
import type { OAuthStore } from './oauth-store';
import { McpProtocol, SUPPORTED_PROTOCOL_VERSIONS, parseError } from './protocol';
import { RECALL_TOOLS, type McpTool } from './tools';

export interface PublicServerOptions {
  issuer: string;
  resource: string;
  ownerToken: string;
  tools?: readonly McpTool[];
  now?: () => number;
  failedApprovalDelayMs?: number;
  /**
   * Access log sink (one line per request: method, path without query, status, user agent, and for
   * `/mcp` the `MCP-Protocol-Version` header). Off when absent.
   */
  log?: (line: string) => void;
}

/**
 * Public listener (meant for Tailscale Funnel): only the MCP endpoint and the OAuth routes that
 * protect it. It shares `RecallService` with the private API but none of its routes: nothing under
 * `/api/v1` is ever served here.
 */
export function createPublicServer(service: RecallService, store: OAuthStore, options: PublicServerOptions) {
  if (options.ownerToken.length < 32) throw new Error('RECALL_TOKEN must contain at least 32 characters');
  const auth = new AuthorizationServer(store, options);
  const oauth = createOAuthRoutes(auth);
  const mcp = new McpProtocol(service, options.tools ?? RECALL_TOOLS);

  async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    // DNS-rebinding protection: browsers send Origin; server-side connectors usually do not.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== options.issuer) throw new HttpError(403, 'Forbidden origin');
    if (!requireBearer(auth, req, res)) return; // 401 with the WWW-Authenticate challenge
    if (req.method !== 'POST') {
      req.resume();
      res.setHeader('Allow', 'POST');
      sendJson(res, 405, { error: 'Method not allowed: this server is stateless and has no SSE stream' });
      return;
    }
    // 2025-11-25: an unsupported version gets 400. A client speaking the stateless 2026-07-28 revision
    // sends it on its first request; this generic error (not the modern -32022) tells it to fall back to
    // `initialize`, so ChatGPT's first authenticated POST may legitimately log a 400.
    const version = req.headers['mcp-protocol-version'];
    if (typeof version === 'string' && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
      req.resume();
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `Unsupported MCP-Protocol-Version: ${version}`,
        data: { supported: SUPPORTED_PROTOCOL_VERSIONS } } });
      return;
    }
    let message: unknown;
    try { message = JSON.parse(await readText(req)); }
    catch (e) { if (e instanceof HttpError) throw e; sendJson(res, 400, parseError()); return; }
    const response = await mcp.handle(message);
    if (!response) { res.statusCode = 202; res.end(); return; }
    sendJson(res, 200, response);
  }

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (options.log) {
      // Path only: the query string of /oauth/authorize carries state and PKCE values.
      const path = (req.url ?? '/').split('?')[0].slice(0, 200);
      const printable = (value: unknown, max: number) => String(value ?? '-').replace(/[^\x20-\x7e]/g, '?').replace(/"/g, "'").slice(0, max);
      const agent = printable(req.headers['user-agent'], 120);
      const version = path === '/mcp' ? ` mcp-protocol-version=${printable(req.headers['mcp-protocol-version'], 40).replace(/ /g, '_')}` : '';
      res.on('finish', () => options.log!(`[Recall MCP] ${new Date().toISOString()} ${req.method} ${path} ${res.statusCode} "${agent}"${version}`));
    }
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path === '/mcp') { await handleMcp(req, res); return; }
      // Metadata (RFC 9728, RFC 8414) and /oauth/* come from the shared package.
      if (!await oauth(req, res)) {
        req.resume();
        sendJson(res, 404, { error: 'Not found' });
      }
    } catch (e) {
      if (!(e instanceof HttpError)) console.error('[Recall MCP]', e);
      if (!res.headersSent && !res.destroyed) sendJson(res, e instanceof HttpError ? e.status : 500,
        { error: e instanceof HttpError ? e.message : 'Internal server error' });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}
