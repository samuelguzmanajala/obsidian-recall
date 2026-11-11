import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { OAuthStore, sha256, type OAuthClient, type StoredToken } from './oauth-store';
import { approvalPage, errorPage } from './approval-page';

/** Framework-free HTTP outcome; `public-server.ts` writes it to the socket. */
export type OAuthResponse =
  | { status: number; json: Record<string, unknown>; headers?: Record<string, string> }
  | { status: number; html: string }
  | { status: 302 | 303; location: string };

export interface AuthorizationServerOptions {
  /** Public origin; also the `iss` of authorization responses (RFC 9207). */
  issuer: string;
  /** Canonical MCP endpoint URI; the only audience tokens are issued for (RFC 8707). */
  resource: string;
  /** `RECALL_TOKEN`: the owner types it on the approval page. */
  ownerToken: string;
  now?: () => number;
}

export const SCOPE = 'recall';
export const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
export const REFRESH_TOKEN_TTL_MS = 60 * 86_400_000;
export const CODE_TTL_MS = 60_000;
export const MAX_FAILED_APPROVALS = 5;
export const FAILED_APPROVAL_WINDOW_MS = 15 * 60_000;
const MAX_CLIENTS = 100;
const UNAPPROVED_CLIENT_TTL_MS = 86_400_000;
const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'];

interface AuthorizationCode {
  clientId: string; redirectUri: string; codeChallenge: string; resource: string; scope: string;
  expiresAt: number; used: boolean; family: string;
}
interface AuthorizeParams {
  client: OAuthClient; redirectUri: string; state?: string; codeChallenge: string; resource: string; scope: string;
}

const random = () => randomBytes(32).toString('base64url');
/** Constant-time for any input length: compares fixed-size digests. */
export function secretEquals(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest(), b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
const oauthError = (status: number, error: string, description: string, headers?: Record<string, string>): OAuthResponse =>
  ({ status, json: { error, error_description: description }, headers });
const trimSlash = (v: string) => v.endsWith('/') ? v.slice(0, -1) : v;

function validRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2000) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.hash || url.username || url.password) return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
}

/**
 * Minimal single-user OAuth 2.1 authorization server for the MCP endpoint: dynamic client
 * registration (RFC 7591), authorization code + PKCE S256, refresh-token rotation, resource
 * indicators (RFC 8707) and issuer identification (RFC 9207). The owner approves a client by
 * typing `RECALL_TOKEN`; there are no user accounts.
 */
export class AuthorizationServer {
  private readonly codes = new Map<string, AuthorizationCode>();
  private failures: number[] = [];
  private readonly now: () => number;
  constructor(private readonly store: OAuthStore, private readonly options: AuthorizationServerOptions) {
    this.now = options.now ?? Date.now;
  }
  get resource() { return this.options.resource; }
  get resourceMetadataUrl() { return `${this.options.issuer}/.well-known/oauth-protected-resource/mcp`; }

  /** RFC 9728 protected resource metadata. */
  resourceMetadata() {
    return { resource: this.options.resource, authorization_servers: [this.options.issuer], scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'], resource_name: 'Recall' };
  }
  /** RFC 8414 authorization server metadata. */
  metadata() {
    const { issuer } = this.options;
    return {
      issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`, scopes_supported: [SCOPE, 'offline_access'],
      response_types_supported: ['code'], response_modes_supported: ['query'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: AUTH_METHODS,
      authorization_response_iss_parameter_supported: true,
    };
  }

  /** RFC 7591 dynamic client registration (open, as MCP clients expect; unapproved clients expire). */
  register(body: unknown): OAuthResponse {
    const invalid = (d: string) => oauthError(400, 'invalid_client_metadata', d);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid('Expected a JSON object');
    const meta = body as Record<string, unknown>;
    const redirectUris = meta.redirect_uris;
    if (!Array.isArray(redirectUris) || !redirectUris.length || redirectUris.length > 10 || !redirectUris.every(validRedirectUri)) {
      return oauthError(400, 'invalid_redirect_uri', 'redirect_uris must be 1–10 absolute https (or loopback http) URIs without fragment');
    }
    const method = meta.token_endpoint_auth_method ?? 'client_secret_basic';
    if (typeof method !== 'string' || !AUTH_METHODS.includes(method)) return invalid(`token_endpoint_auth_method must be one of ${AUTH_METHODS.join(', ')}`);
    const grantTypes = meta.grant_types ?? ['authorization_code', 'refresh_token'];
    if (!Array.isArray(grantTypes) || !grantTypes.every(g => g === 'authorization_code' || g === 'refresh_token')) return invalid('Unsupported grant_types');
    const responseTypes = meta.response_types ?? ['code'];
    if (!Array.isArray(responseTypes) || !responseTypes.every(r => r === 'code')) return invalid('Unsupported response_types');
    const clientName = meta.client_name;
    if (clientName !== undefined && (typeof clientName !== 'string' || clientName.length > 200)) return invalid('Invalid client_name');
    const now = this.now();
    this.store.pruneUnapprovedClients(now, UNAPPROVED_CLIENT_TTL_MS);
    if (this.store.countClients() >= MAX_CLIENTS) return oauthError(429, 'temporarily_unavailable', 'Too many registered clients');
    const clientId = randomUUID();
    const secret = method === 'none' ? undefined : random();
    const metadata = {
      redirect_uris: redirectUris as string[], token_endpoint_auth_method: method, grant_types: grantTypes, response_types: responseTypes,
      ...(clientName === undefined ? {} : { client_name: clientName }),
    };
    this.store.addClient({ clientId, secretHash: secret ? sha256(secret) : null, metadata, createdAt: now });
    return { status: 201, json: { client_id: clientId, client_id_issued_at: Math.floor(now / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}), ...metadata } };
  }

  /**
   * Validates an authorization request. Unknown client or unregistered redirect URI → error page,
   * never a redirect (RFC 6749 §4.1.2.1); other errors are redirected to the client with `iss`.
   */
  private validate(p: URLSearchParams): AuthorizeParams | OAuthResponse {
    const client = this.store.findClient(p.get('client_id') ?? '');
    if (!client) return { status: 400, html: errorPage('Unknown client. Remove the connector and add it again.') };
    const redirectUri = p.get('redirect_uri') ?? '';
    if (!client.metadata.redirect_uris.includes(redirectUri)) return { status: 400, html: errorPage('The redirect URI is not registered for this client.') };
    const state = p.get('state') ?? undefined;
    const fail = (error: string, description: string) => this.redirect(redirectUri, { error, error_description: description, state });
    if (p.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported');
    const codeChallenge = p.get('code_challenge') ?? '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge) || p.get('code_challenge_method') !== 'S256') {
      return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    }
    const resource = this.checkResource(p.get('resource'));
    if (!resource) return fail('invalid_target', `resource must be ${this.options.resource}`);
    return { client, redirectUri, state, codeChallenge, resource, scope: SCOPE };
  }
  /** GET /oauth/authorize: the approval page. */
  authorize(p: URLSearchParams): OAuthResponse {
    const request = this.validate(p);
    if ('status' in request) return request;
    return { status: 200, html: approvalPage(request.client, request.redirectUri, p) };
  }
  /** POST /oauth/authorize: the owner approves (with `RECALL_TOKEN`) or denies. */
  approve(form: URLSearchParams): OAuthResponse {
    const request = this.validate(form);
    if ('status' in request) return request;
    const now = this.now();
    if (form.get('decision') === 'deny') {
      return this.redirect(request.redirectUri, { error: 'access_denied', error_description: 'The owner denied access', state: request.state }, 303);
    }
    this.failures = this.failures.filter(t => t > now - FAILED_APPROVAL_WINDOW_MS);
    if (this.failures.length >= MAX_FAILED_APPROVALS) {
      return { status: 429, html: errorPage('Too many failed attempts. Wait 15 minutes and try again.') };
    }
    if (!secretEquals(form.get('owner_token') ?? '', this.options.ownerToken)) {
      this.failures.push(now);
      return { status: 401, html: approvalPage(request.client, request.redirectUri, form, 'Wrong token.') };
    }
    this.store.markApproved(request.client.clientId, now);
    for (const [key, entry] of this.codes) if (entry.expiresAt + CODE_TTL_MS < now) this.codes.delete(key);
    const code = random();
    this.codes.set(sha256(code), { clientId: request.client.clientId, redirectUri: request.redirectUri, codeChallenge: request.codeChallenge,
      resource: request.resource, scope: request.scope, expiresAt: now + CODE_TTL_MS, used: false, family: randomUUID() });
    return this.redirect(request.redirectUri, { code, state: request.state }, 303);
  }

  /** POST /oauth/token (form-encoded). */
  token(form: URLSearchParams, authorization: string | undefined): OAuthResponse {
    const client = this.authenticateClient(form, authorization);
    if ('status' in client) return client;
    const now = this.now();
    this.store.purgeExpired(now);
    const grantType = form.get('grant_type');
    if (grantType === 'authorization_code') {
      const key = sha256(form.get('code') ?? '');
      const code = this.codes.get(key);
      if (!code || code.clientId !== client.clientId) return oauthError(400, 'invalid_grant', 'Unknown authorization code');
      if (code.used) {
        // RFC 6749 §4.1.2: a replayed code revokes everything issued from it.
        this.store.revokeFamily(code.family);
        return oauthError(400, 'invalid_grant', 'Authorization code already used');
      }
      code.used = true; // single use, even if the rest of the request fails
      if (code.expiresAt <= now) return oauthError(400, 'invalid_grant', 'Authorization code expired');
      if (form.get('redirect_uri') !== code.redirectUri) return oauthError(400, 'invalid_grant', 'redirect_uri does not match');
      const verifier = form.get('code_verifier') ?? '';
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || createHash('sha256').update(verifier).digest('base64url') !== code.codeChallenge) {
        return oauthError(400, 'invalid_grant', 'PKCE verification failed');
      }
      if (form.has('resource') && this.checkResource(form.get('resource')) !== code.resource) return oauthError(400, 'invalid_target', 'resource does not match');
      return this.issue(client.clientId, code.family, code.resource, code.scope, now);
    }
    if (grantType === 'refresh_token') {
      const presented = form.get('refresh_token') ?? '';
      const stored = this.store.findToken(presented);
      if (!stored || stored.kind !== 'refresh' || stored.clientId !== client.clientId || stored.expiresAt <= now) {
        return oauthError(400, 'invalid_grant', 'Invalid refresh token');
      }
      if (form.has('resource') && this.checkResource(form.get('resource')) !== stored.resource) return oauthError(400, 'invalid_target', 'resource does not match');
      if (!this.store.consumeRefreshToken(presented)) {
        // Rotated token replayed: assume it leaked and revoke the whole grant (OAuth 2.1 §4.3.1).
        this.store.revokeFamily(stored.family);
        return oauthError(400, 'invalid_grant', 'Refresh token already used');
      }
      return this.issue(client.clientId, stored.family, stored.resource, stored.scope, now);
    }
    return oauthError(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
  }

  /** Bearer token on the MCP endpoint: an unexpired, unrevoked access token issued for this resource. */
  verifyAccessToken(token: string): StoredToken | undefined {
    const stored = this.store.findToken(token);
    if (!stored || stored.kind !== 'access' || stored.revoked || stored.expiresAt <= this.now() || stored.resource !== this.options.resource) return undefined;
    return stored;
  }

  private issue(clientId: string, family: string, resource: string, scope: string, now: number): OAuthResponse {
    const accessToken = random(), refreshToken = random();
    this.store.addToken(accessToken, { kind: 'access', clientId, family, resource, scope, expiresAt: now + ACCESS_TOKEN_TTL_MS, revoked: false });
    this.store.addToken(refreshToken, { kind: 'refresh', clientId, family, resource, scope, expiresAt: now + REFRESH_TOKEN_TTL_MS, revoked: false });
    return { status: 200, headers: { Pragma: 'no-cache' }, json: { access_token: accessToken, token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_MS / 1000, refresh_token: refreshToken, scope } };
  }
  private authenticateClient(form: URLSearchParams, authorization: string | undefined): OAuthClient | OAuthResponse {
    let clientId = form.get('client_id') ?? undefined, secret = form.get('client_secret') ?? undefined;
    const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(authorization?.trim() ?? '');
    if (basic) {
      const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      try {
        if (colon < 0) throw new Error('no colon');
        clientId = decodeURIComponent(decoded.slice(0, colon));
        secret = decodeURIComponent(decoded.slice(colon + 1));
      } catch { return oauthError(401, 'invalid_client', 'Malformed Basic credentials', { 'WWW-Authenticate': 'Basic' }); }
    }
    const client = clientId ? this.store.findClient(clientId) : undefined;
    if (!client) return oauthError(401, 'invalid_client', 'Unknown client');
    if (client.secretHash === null) return client;
    if (!secret || !secretEquals(sha256(secret), client.secretHash)) {
      return oauthError(401, 'invalid_client', 'Client authentication failed', basic ? { 'WWW-Authenticate': 'Basic' } : undefined);
    }
    return client;
  }
  /** RFC 8707: the only valid target is this MCP endpoint; an absent `resource` defaults to it. */
  private checkResource(value: string | null): string | undefined {
    if (value === null) return this.options.resource;
    return trimSlash(value) === this.options.resource ? this.options.resource : undefined;
  }
  private redirect(redirectUri: string, params: Record<string, string | undefined>, status: 302 | 303 = 302): OAuthResponse {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    url.searchParams.set('iss', this.options.issuer);
    return { status, location: url.toString() };
  }
}
