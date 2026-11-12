import type { RecallService } from '../service';
import { readMcpConfig } from './config';
import { OAuthStore } from './oauth-store';
import { createPublicServer } from './public-server';

export interface PublicMcp { listen(): void; close(): Promise<void> }

/** The public MCP listener, or `undefined` when `RECALL_MCP_*` is not configured (the backend then behaves as before). */
export function configureMcp(env: NodeJS.ProcessEnv, recallDb: string, service: RecallService, token: string): PublicMcp | undefined {
  const config = readMcpConfig(env, recallDb);
  if (!config) return undefined;
  const store = new OAuthStore(config.oauthDb);
  const server = createPublicServer(service, store, { issuer: config.issuer, resource: config.resource, ownerToken: token, log: line => console.log(line) });
  // Without a listener, a failed listen (e.g. EADDRINUSE) would be an uncaught 'error' event and take
  // the private API down with it. The MCP listener is optional: report it and keep the backend running.
  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error(`Recall MCP listener on ${config.host}:${config.port} failed${error.code ? ` (${error.code})` : ''}; `
      + 'the private API keeps running without the MCP connector:', error.message);
  });
  return {
    listen: () => server.listen(config.port, config.host, () => {
      console.log(`Recall MCP listening on ${config.host}:${config.port} (public URL ${config.resource})`);
    }),
    close: async () => {
      server.closeIdleConnections();
      if (server.listening) await new Promise<void>(r => server.close(() => r()));
      store.close();
    },
  };
}
