import type { RecallService } from '../service';

/** MCP tool annotations (hints for the client; never trusted for security). */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
/** One MCP tool. Adding a tool to the connector means adding an entry to `RECALL_TOOLS`. */
export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown> & { type: 'object' };
  annotations: ToolAnnotations;
  /** `args` is the raw `arguments` object of `tools/call`; validate it. Throw `ToolInputError` for bad input. */
  call(service: RecallService, args: Record<string, unknown>): Promise<ToolResult>;
}
export class ToolInputError extends Error {}

function json(value: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const listDecks: McpTool = {
  name: 'list_decks',
  title: 'List decks',
  description: 'Lists the user\'s Recall flashcard decks as a tree. Each deck has an id, a name, totalItems (cards in the deck '
    + 'and its subdecks), dueItems (cards due for review now) and newItems (never-reviewed cards), plus its child decks. '
    + 'Use it to see what the user can study and how much is due. Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'List decks', ...READ_ONLY },
  call: async service => json({ decks: await service.query(c => c.getDeckTree.execute()) }),
};

export const RECALL_TOOLS: readonly McpTool[] = [listDecks];
