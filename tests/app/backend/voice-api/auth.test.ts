import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'http';
import { checkAuth, generateToken } from '@app/backend/voice-api/auth';

function fakeReq(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('generateToken', () => {
  it('returns 64 hex chars (256 bits)', () => {
    const token = generateToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns a different token each call', () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});

describe('checkAuth', () => {
  const token = 'a'.repeat(64);

  it('accepts a correct Bearer token', () => {
    const req = fakeReq({ authorization: `Bearer ${token}` });
    expect(checkAuth(req, token)).toBe(true);
  });

  it('accepts case-insensitive scheme', () => {
    const req = fakeReq({ authorization: `bearer ${token}` });
    expect(checkAuth(req, token)).toBe(true);
  });

  it('rejects missing Authorization header', () => {
    const req = fakeReq({});
    expect(checkAuth(req, token)).toBe(false);
  });

  it('rejects malformed header (no Bearer scheme)', () => {
    const req = fakeReq({ authorization: token });
    expect(checkAuth(req, token)).toBe(false);
  });

  it('rejects wrong token of same length', () => {
    const wrong = 'b'.repeat(64);
    const req = fakeReq({ authorization: `Bearer ${wrong}` });
    expect(checkAuth(req, token)).toBe(false);
  });

  it('rejects wrong token of different length without throwing', () => {
    const req = fakeReq({ authorization: 'Bearer short' });
    expect(checkAuth(req, token)).toBe(false);
  });

  it('rejects when expectedToken is empty (server unconfigured)', () => {
    const req = fakeReq({ authorization: 'Bearer anything' });
    expect(checkAuth(req, '')).toBe(false);
  });

  it('tolerates extra whitespace around the token', () => {
    const req = fakeReq({ authorization: `Bearer   ${token}  ` });
    expect(checkAuth(req, token)).toBe(true);
  });
});
