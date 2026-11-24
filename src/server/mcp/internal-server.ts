import { createServer } from 'node:http';
import { HttpError, secretEquals } from '@samuelguzman/mcp-oauth';
import { sendJson } from '../send-json';
import type { RecallService } from '../service';
import { McpProtocol } from './protocol';
import { serveMcpPost } from './serve';
import type { McpTool } from './tools';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface InternalServerOptions {
  /** `RECALL_MCP_INTERNAL_SECRET`: the only credential, sent as `Authorization: Bearer <secret>`. */
  secret: string;
  tools: readonly McpTool[];
  log?: (line: string) => void;
}

/**
 * Internal MCP listener for a local gateway (mcp-hub): the same MCP endpoint as the public listener,
 * authenticated with a shared secret instead of OAuth, and never published. It must listen on
 * loopback only (`configureInternalMcp` does); on top of that it refuses non-loopback `Host` headers and
 * any `Origin` (a gateway is a server, never a browser), so a web page cannot reach it via DNS rebinding.
 * The secret is not valid on the public listener, and OAuth tokens are not valid here.
 */
export function createInternalServer(service: RecallService, options: InternalServerOptions) {
  if (options.secret.length < 32) throw new Error('RECALL_MCP_INTERNAL_SECRET must contain at least 32 characters');
  const mcp = new McpProtocol(service, options.tools);
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (options.log) {
      const path = (req.url ?? '/').split('?')[0].slice(0, 200);
      res.on('finish', () => options.log!(`[Recall MCP internal] ${new Date().toISOString()} ${req.method} ${path} ${res.statusCode}`));
    }
    try {
      let host: string;
      try { host = new URL(`http://${req.headers.host ?? ''}`).hostname; } catch { host = ''; }
      if (!LOOPBACK.has(host) || req.headers.origin !== undefined) throw new HttpError(403, 'Forbidden');
      if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/mcp') throw new HttpError(404, 'Not found');
      const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization?.trim() ?? '');
      if (!bearer || !secretEquals(bearer[1], options.secret)) {
        req.resume();
        res.setHeader('WWW-Authenticate', 'Bearer');
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      await serveMcpPost(mcp, req, res);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error('[Recall MCP internal]', e);
      req.resume();
      if (!res.headersSent && !res.destroyed) sendJson(res, e instanceof HttpError ? e.status : 500,
        { error: e instanceof HttpError ? e.message : 'Internal server error' });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}
