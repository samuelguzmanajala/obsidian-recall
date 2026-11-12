import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export interface OAuthClient {
  clientId: string;
  /** SHA-256 of the client secret, or null for a public client (`token_endpoint_auth_method: none`). */
  secretHash: string | null;
  /** The registration response (RFC 7591 client metadata), without the secret. */
  metadata: Record<string, unknown> & { redirect_uris: string[]; token_endpoint_auth_method: string };
  createdAt: number;
}
export interface StoredToken {
  kind: 'access' | 'refresh';
  clientId: string;
  /** All tokens descending from one authorization code; revoked together on refresh-token or code reuse. */
  family: string;
  resource: string;
  scope: string;
  expiresAt: number;
  /** Rotated refresh tokens are kept (revoked) until expiry to detect reuse. */
  revoked: boolean;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS oauth_clients (client_id TEXT PRIMARY KEY, secret_hash TEXT, metadata TEXT NOT NULL, created_at INTEGER NOT NULL,
    approved_at INTEGER);
  CREATE TABLE IF NOT EXISTS oauth_tokens (token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('access','refresh')),
    client_id TEXT NOT NULL, family TEXT NOT NULL, resource TEXT NOT NULL, scope TEXT NOT NULL, expires_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS oauth_tokens_family ON oauth_tokens (family);
  CREATE INDEX IF NOT EXISTS oauth_tokens_client ON oauth_tokens (client_id);
`;

/**
 * OAuth state of the public MCP listener in its own SQLite file: registered clients and the
 * SHA-256 hashes of issued tokens (never the tokens). Kept apart from the study database so its
 * schema evolves independently of the study migrations and a copy of the study data carries no
 * credentials. Losing it only forces clients to register and authorize again.
 */
export class OAuthStore {
  private readonly sql: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.sql = new DatabaseSync(path);
    const version = Number(this.sql.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version > 1) { this.sql.close(); throw new Error('OAuth database schema is newer than this server'); }
    this.sql.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; BEGIN; ${SCHEMA} PRAGMA user_version=1; COMMIT;`);
  }
  addClient(client: OAuthClient): void {
    this.sql.prepare('INSERT INTO oauth_clients VALUES (?,?,?,?,NULL)')
      .run(client.clientId, client.secretHash, JSON.stringify(client.metadata), client.createdAt);
  }
  findClient(clientId: string): OAuthClient | undefined {
    const row = this.sql.prepare('SELECT * FROM oauth_clients WHERE client_id=?').get(clientId);
    return row && { clientId: row.client_id as string, secretHash: row.secret_hash as string | null,
      metadata: JSON.parse(row.metadata as string), createdAt: Number(row.created_at) };
  }
  countClients(): number {
    return Number(this.sql.prepare('SELECT count(*) AS n FROM oauth_clients').get()!.n);
  }
  /** Deletes the oldest never-approved clients until at most `keep` remain; approved clients are untouched. */
  evictOldestUnapprovedClients(keep: number): void {
    this.sql.prepare(`DELETE FROM oauth_clients WHERE client_id IN (SELECT client_id FROM oauth_clients WHERE approved_at IS NULL
      ORDER BY created_at, rowid LIMIT max(0, (SELECT count(*) FROM oauth_clients WHERE approved_at IS NULL) - ?))`).run(keep);
  }
  /** Records that the owner approved this client at least once; approved clients are never pruned. */
  markApproved(clientId: string, now: number): void {
    this.sql.prepare('UPDATE oauth_clients SET approved_at=? WHERE client_id=?').run(now, clientId);
  }
  /** Registration is anonymous: drop clients the owner never approved within `maxAgeMs`. */
  pruneUnapprovedClients(now: number, maxAgeMs: number): void {
    this.sql.prepare('DELETE FROM oauth_clients WHERE approved_at IS NULL AND created_at < ?').run(now - maxAgeMs);
  }
  addToken(token: string, data: StoredToken): void {
    this.sql.prepare('INSERT INTO oauth_tokens VALUES (?,?,?,?,?,?,?,?)').run(sha256(token), data.kind, data.clientId,
      data.family, data.resource, data.scope, data.expiresAt, data.revoked ? 1 : 0);
  }
  findToken(token: string): StoredToken | undefined {
    const row = this.sql.prepare('SELECT * FROM oauth_tokens WHERE token_hash=?').get(sha256(token));
    return row && { kind: row.kind as StoredToken['kind'], clientId: row.client_id as string, family: row.family as string,
      resource: row.resource as string, scope: row.scope as string, expiresAt: Number(row.expires_at), revoked: row.revoked === 1 };
  }
  /** Atomically marks an active refresh token as used; false if it was already used or does not exist. */
  consumeRefreshToken(token: string): boolean {
    return Number(this.sql.prepare("UPDATE oauth_tokens SET revoked=1 WHERE token_hash=? AND kind='refresh' AND revoked=0")
      .run(sha256(token)).changes) === 1;
  }
  revokeFamily(family: string): void {
    this.sql.prepare('DELETE FROM oauth_tokens WHERE family=?').run(family);
  }
  purgeExpired(now: number): void {
    this.sql.prepare('DELETE FROM oauth_tokens WHERE expires_at <= ?').run(now);
  }
  close(): void { this.sql.close(); }
}
