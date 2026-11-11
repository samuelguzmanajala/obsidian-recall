import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { sendJson } from '../send-json';
import type { RecallService } from '../service';
import { AuthorizationServer, SCOPE, type OAuthResponse } from './oauth';
import type { OAuthStore } from './oauth-store';
import { McpProtocol, SUPPORTED_PROTOCOL_VERSIONS, parseError } from './protocol';
import { RECALL_TOOLS, type McpTool } from './tools';

export interface PublicServerOptions {
  issuer: string;
  resource: string;
  ownerToken: string;
  tools?: readonly McpTool[];
  now?: () => number;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function readText(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  if (Number(req.headers['content-length'] ?? 0) > limit) { req.resume(); throw new HttpError(413, 'Request too large'); }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  if (!/^application\/x-www-form-urlencoded\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Expected application/x-www-form-urlencoded');
  return new URLSearchParams(await readText(req, 64_000));
}
function send(res: ServerResponse, outcome: OAuthResponse): void {
  if ('location' in outcome) {
    res.statusCode = outcome.status;
    res.setHeader('Location', outcome.location);
    res.end();
  } else if ('html' in outcome) {
    res.statusCode = outcome.status;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.end(outcome.html);
  } else {
    for (const [k, v] of Object.entries(outcome.headers ?? {})) res.setHeader(k, v);
    sendJson(res, outcome.status, outcome.json);
  }
}

/**
 * Public listener (meant for Tailscale Funnel): only the MCP endpoint and the OAuth routes that
 * protect it. It shares `RecallService` with the private API but none of its routes: nothing under
 * `/api/v1` is ever served here.
 */
export function createPublicServer(service: RecallService, store: OAuthStore, options: PublicServerOptions) {
  if (options.ownerToken.length < 32) throw new Error('RECALL_TOKEN must contain at least 32 characters');
  const auth = new AuthorizationServer(store, options);
  const mcp = new McpProtocol(service, options.tools ?? RECALL_TOOLS);
  const challenge = (error?: string) => `Bearer resource_metadata="${auth.resourceMetadataUrl}", scope="${SCOPE}"`
    + (error ? `, error="${error}", error_description="The access token is missing, expired, revoked or not issued for this server"` : '');

  async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    // DNS-rebinding protection: browsers send Origin; server-side connectors usually do not.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== options.issuer) throw new HttpError(403, 'Forbidden origin');
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization?.trim() ?? '');
    if (!bearer || !auth.verifyAccessToken(bearer[1])) {
      req.resume();
      res.setHeader('WWW-Authenticate', challenge(bearer ? 'invalid_token' : undefined));
      sendJson(res, 401, { error: bearer ? 'invalid_token' : 'unauthorized' });
      return;
    }
    if (req.method !== 'POST') {
      req.resume();
      res.setHeader('Allow', 'POST');
      sendJson(res, 405, { error: 'Method not allowed: this server is stateless and has no SSE stream' });
      return;
    }
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
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname, method = req.method;
      if (path === '/mcp') { await handleMcp(req, res); return; }
      if (method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) {
        sendJson(res, 200, auth.resourceMetadata());
      } else if (method === 'GET' && path === '/.well-known/oauth-authorization-server') {
        sendJson(res, 200, auth.metadata());
      } else if (method === 'POST' && path === '/oauth/register') {
        let body: unknown;
        try { body = JSON.parse(await readText(req, 64_000)); } catch (e) { if (e instanceof HttpError) throw e; body = undefined; }
        send(res, auth.register(body));
      } else if (method === 'GET' && path === '/oauth/authorize') {
        send(res, auth.authorize(url.searchParams));
      } else if (method === 'POST' && path === '/oauth/authorize') {
        send(res, auth.approve(await readForm(req)));
      } else if (method === 'POST' && path === '/oauth/token') {
        send(res, auth.token(await readForm(req), req.headers.authorization));
      } else {
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
