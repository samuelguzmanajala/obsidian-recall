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
  const server = createPublicServer(service, store, { issuer: config.issuer, resource: config.resource, ownerToken: token });
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
