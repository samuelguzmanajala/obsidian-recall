import type { RecallService } from '../service';
import { ToolInputError, type McpTool } from './tools';

/**
 * Handshake-based ("legacy") revisions, newest first. The first is offered when the client asks for an
 * unknown one. Revision 2026-07-28 (stateless, no `initialize`) is not implemented: a dual-era client
 * first sends a modern request, gets our 400 without the modern `UnsupportedProtocolVersionError`
 * (-32022) and, as that revision specifies, falls back to `initialize` (see `public-server.ts`).
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
export const SERVER_INFO = { name: 'recall', title: 'Recall', version: '0.1.0' };

type Id = string | number;
export interface JsonRpcResponse { jsonrpc: '2.0'; id: Id | null; result?: unknown; error?: { code: number; message: string; data?: unknown } }

export const INSTRUCTIONS = 'Recall is the user\'s spaced-repetition flashcard system (typically language vocabulary and grammar, '
  + 'technical and general-knowledge cards). Act as a tutor and steer the conversation toward what the user needs '
  + 'to review or keeps failing. list_decks shows the decks and their ids; pass a deck "id" as deckId to narrow the other tools '
  + 'to that deck and its subdecks. get_due_cards gives what is due now (what to practise first); get_weak_cards ranks what the '
  + 'user is shaky on, including recent failures; get_leeches lists chronic failures; search_cards checks whether a word or topic '
  + 'already has a card; get_study_stats summarises progress. Cards have a prompt (the question side) and an answer, '
  + 'and next: for each rating (again, hard, good, easy) when the card would come back if the user rated it now, so you can tell '
  + 'them before they answer. Sides are Markdown, so speak their content naturally and skip formatting and image embeds. All tools are read-only: quizzing the user '
  + 'here does not record reviews or change any schedule, so the user still reviews these cards in the Recall app.';

const PARSE_ERROR = -32700, INVALID_REQUEST = -32600, METHOD_NOT_FOUND = -32601, INVALID_PARAMS = -32602, INTERNAL_ERROR = -32603;
const failure = (id: Id | null, code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });
const isId = (v: unknown): v is Id => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Stateless MCP server over the Streamable HTTP transport: one JSON-RPC message per POST, answered
 * with a single `application/json` body (no SSE, no sessions). Only the methods needed by a tools-only
 * server are implemented. Returns `undefined` for notifications (HTTP 202).
 */
export class McpProtocol {
  private readonly tools: Map<string, McpTool>;
  constructor(private readonly service: RecallService, tools: readonly McpTool[]) {
    this.tools = new Map(tools.map(t => [t.name, t]));
  }
  async handle(message: unknown): Promise<JsonRpcResponse | undefined> {
    if (Array.isArray(message)) return failure(null, INVALID_REQUEST, 'JSON-RPC batches are not supported');
    // A response from the client (we never send requests to it): acknowledge like a notification.
    if (isObject(message) && message.jsonrpc === '2.0' && !('method' in message) && ('result' in message || 'error' in message)) return undefined;
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return failure(isObject(message) && isId(message.id) ? message.id : null, INVALID_REQUEST, 'Invalid JSON-RPC request');
    }
    if (!('id' in message)) return undefined; // notification (e.g. notifications/initialized): nothing to answer
    if (!isId(message.id)) return failure(null, INVALID_REQUEST, 'Invalid id');
    const id = message.id;
    const params = message.params === undefined ? {} : message.params;
    if (!isObject(params)) return failure(id, INVALID_PARAMS, 'params must be an object');
    try {
      const result = await this.dispatch(message.method, params);
      return result === undefined ? failure(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`) : { jsonrpc: '2.0', id, result };
    } catch (e) {
      if (e instanceof ToolInputError) return failure(id, INVALID_PARAMS, e.message);
      console.error('[Recall MCP]', e);
      return failure(id, INTERNAL_ERROR, 'Internal error');
    }
  }
  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.find(v => v === requested) ?? SUPPORTED_PROTOCOL_VERSIONS[0];
        return {
          protocolVersion, serverInfo: SERVER_INFO, capabilities: { tools: { listChanged: false } },
          instructions: INSTRUCTIONS,
        };
      }
      case 'ping': return {};
      case 'tools/list':
        return { tools: [...this.tools.values()].map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) };
      case 'tools/call': {
        const tool = typeof params.name === 'string' ? this.tools.get(params.name) : undefined;
        if (!tool) throw new ToolInputError(`Unknown tool: ${String(params.name)}`);
        const args = params.arguments === undefined ? {} : params.arguments;
        if (!isObject(args)) throw new ToolInputError('arguments must be an object');
        // Invalid tool input is a tool execution error (isError), not a protocol error, so the model
        // sees the message and can retry (MCP 2025-11-25, server/tools "Error Handling").
        try { return await tool.call(this.service, args); }
        catch (e) {
          if (e instanceof ToolInputError) return { content: [{ type: 'text', text: e.message }], isError: true };
          throw e;
        }
      }
      default: return undefined;
    }
  }
}
export const parseError = () => failure(null, PARSE_ERROR, 'Parse error');
