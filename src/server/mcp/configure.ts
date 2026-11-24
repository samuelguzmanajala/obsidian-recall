import type { RecallService } from '../service';
import { readInternalMcpConfig, readMcpConfig } from './config';
import { createInternalServer } from './internal-server';
import { OAuthStore } from './oauth-store';
import { createPublicServer } from './public-server';
import { RECALL_TOOLS } from './tools';
import { RECALL_WRITE_TOOLS } from './write-tools';

export interface PublicMcp { listen(): void; close(): Promise<void> }

/** The tools the connector exposes: the six read-only ones, plus the write tools only with `RECALL_MCP_WRITE=true`. */
export const mcpTools = (write: boolean) => write ? [...RECALL_TOOLS, ...RECALL_WRITE_TOOLS] : RECALL_TOOLS;

/** The public MCP listener, or `undefined` when `RECALL_MCP_*` is not configured (the backend then behaves as before). */
export function configureMcp(env: NodeJS.ProcessEnv, recallDb: string, service: RecallService, token: string): PublicMcp | undefined {
  const config = readMcpConfig(env, recallDb);
  if (!config) return undefined;
  const store = new OAuthStore(config.oauthDb);
  const tools = mcpTools(config.write);
  const server = createPublicServer(service, store, { issuer: config.issuer, resource: config.resource, ownerToken: token, tools, log: line => console.log(line) });
  // Without a listener, a failed listen (e.g. EADDRINUSE) would be an uncaught 'error' event and take
  // the private API down with it. The MCP listener is optional: report it and keep the backend running.
  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error(`Recall MCP listener on ${config.host}:${config.port} failed${error.code ? ` (${error.code})` : ''}; `
      + 'the private API keeps running without the MCP connector:', error.message);
  });
  return {
    listen: () => server.listen(config.port, config.host, () => {
      console.log(`Recall MCP listening on ${config.host}:${config.port} (public URL ${config.resource}; ${config.write ? 'write tools enabled' : 'read-only tools'})`);
    }),
    close: async () => {
      server.closeIdleConnections();
      if (server.listening) await new Promise<void>(r => server.close(() => r()));
      store.close();
    },
  };
}

/**
 * The internal MCP listener for a local gateway (mcp-hub), or `undefined` when `RECALL_MCP_INTERNAL_*` is
 * not configured. Loopback only, whatever `RECALL_MCP_HOST` says; optional like the public one.
 */
export function configureInternalMcp(env: NodeJS.ProcessEnv, service: RecallService): PublicMcp | undefined {
  const config = readInternalMcpConfig(env);
  if (!config) return undefined;
  const server = createInternalServer(service, { secret: config.secret, tools: mcpTools(config.write), log: line => console.log(line) });
  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error(`Recall internal MCP listener on 127.0.0.1:${config.port} failed${error.code ? ` (${error.code})` : ''}; `
      + 'the rest of the backend keeps running:', error.message);
  });
  return {
    listen: () => server.listen(config.port, '127.0.0.1', () => {
      console.log(`Recall internal MCP listening on 127.0.0.1:${config.port} (${config.write ? 'write tools enabled' : 'read-only tools'})`);
    }),
    close: async () => {
      server.closeIdleConnections();
      if (server.listening) await new Promise<void>(r => server.close(() => r()));
    },
  };
}
