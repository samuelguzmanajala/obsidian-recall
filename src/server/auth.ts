import { randomBytes, timingSafeEqual } from 'crypto';
import type { IncomingMessage } from 'http';

/**
 * Generate a fresh API token: 32 bytes of cryptographic randomness, hex-encoded.
 * Result is 64 hex chars (256 bits). Stored in plugin settings; the user copies
 * it once into the mobile client.
 */
export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Validate an `Authorization: Bearer <token>` header against the expected token.
 * Returns false on any failure (missing/malformed header, length mismatch, wrong
 * value). Comparison is constant-time when lengths match to thwart timing attacks.
 *
 * `expectedToken` empty/falsy always fails — protects against accidentally
 * accepting requests when the user has not configured a token yet.
 */
export function checkAuth(req: IncomingMessage, expectedToken: string): boolean {
  if (!expectedToken) return false;

  const header = req.headers['authorization'];
  if (typeof header !== 'string') return false;

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;

  const presented = match[1].trim();
  if (presented.length !== expectedToken.length) return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(expectedToken);
  return a.length === b.length && timingSafeEqual(a, b);
}
