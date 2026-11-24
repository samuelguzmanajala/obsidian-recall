import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readText } from '@samuelguzman/mcp-oauth';
import { sendJson } from '../send-json';
import { McpProtocol, SUPPORTED_PROTOCOL_VERSIONS, parseError } from './protocol';

/**
 * Serves one authenticated request to `/mcp` (shared by the public and the internal listener, which
 * differ only in how they authenticate): POST only, a supported `MCP-Protocol-Version`, one JSON-RPC
 * message per request answered with a single JSON body.
 */
export async function serveMcpPost(mcp: McpProtocol, req: IncomingMessage, res: ServerResponse): Promise<void> {
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
