import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Request } from 'express';

let mockJwtSecret: string | undefined = 'test-jwt-secret-for-state-store';

vi.mock('@server/utils/config', () => ({
  Config: {
    get JWT_SECRET() {
      return mockJwtSecret;
    },
  },
}));

vi.mock('@bike4mind/observability', () => ({
  Logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { PassportOAuthStateStore } from './passportOAuthStateStore';
import type OAuth2Strategy from 'passport-oauth2';

const mockReq = {} as Request;

function callStore(
  s: PassportOAuthStateStore,
  req: Request
): Promise<{ err: Error | null; token: string | undefined }> {
  return new Promise(resolve => {
    s.store(req, {} as OAuth2Strategy.Metadata, (err, token) => resolve({ err, token }));
  });
}

function callVerify(
  s: PassportOAuthStateStore,
  req: Request,
  state: string
): Promise<{ err: Error | null; ok: boolean; info: unknown }> {
  return new Promise(resolve => {
    s.verify(req, state, {} as OAuth2Strategy.Metadata, (err, ok, info) => resolve({ err, ok, info }));
  });
}

describe('PassportOAuthStateStore', () => {
  let store: PassportOAuthStateStore;

  beforeEach(() => {
    vi.clearAllMocks();
    mockJwtSecret = 'test-jwt-secret-for-state-store';
    store = new PassportOAuthStateStore('github-oauth-state');
  });

  describe('store()', () => {
    it('returns a signed JWT as the state handle', async () => {
      const { err, token } = await callStore(store, mockReq);
      expect(err).toBeNull();
      expect(token).toBeDefined();
      expect(typeof token).toBe('string');

      const decoded = jwt.decode(token!) as Record<string, unknown>;
      expect(decoded.aud).toBe('github-oauth-state');
      expect(decoded.iss).toBe('bike4mind');
      expect(decoded.handle).toBeDefined();
    });

    it('calls back with error when JWT_SECRET is missing', async () => {
      mockJwtSecret = undefined;
      const { err } = await callStore(store, mockReq);
      expect(err).toBeInstanceOf(Error);
    });

    it('embeds req.query.redirectTo in the state token, recoverable on the callback', async () => {
      const redirectTo = '/oauth/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fapp';
      const reqWithRedirect = { query: { redirectTo } } as unknown as Request;
      const { err, token } = await callStore(store, reqWithRedirect);
      expect(err).toBeNull();

      const decoded = jwt.decode(token!) as Record<string, unknown>;
      expect(decoded.redirectTo).toBe(redirectTo);
    });

    it('omits redirectTo when not present on the request', async () => {
      const { token } = await callStore(store, mockReq);
      const decoded = jwt.decode(token!) as Record<string, unknown>;
      expect(decoded.redirectTo).toBeUndefined();
    });
  });

  describe('verify() error handling', () => {
    it('calls back with error when JWT_SECRET is missing', async () => {
      mockJwtSecret = undefined;
      const { token } = await (async () => {
        mockJwtSecret = 'test-jwt-secret-for-state-store';
        const result = await callStore(store, mockReq);
        mockJwtSecret = undefined;
        return result;
      })();
      const { err, ok } = await callVerify(store, mockReq, token!);
      expect(err).toBeInstanceOf(Error);
      expect(ok).toBe(false);
    });
  });

  describe('verify()', () => {
    it('accepts a valid round-trip token', async () => {
      const { token } = await callStore(store, mockReq);
      const { err, ok, info } = await callVerify(store, mockReq, token!);
      expect(err).toBeNull();
      expect(ok).toBe(true);
      expect(info).toBeDefined();
    });

    it('round-trips an embedded redirectTo through store → verify', async () => {
      const redirectTo = '/oauth/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fapp';
      const reqWithRedirect = { query: { redirectTo } } as unknown as Request;
      const { token } = await callStore(store, reqWithRedirect);
      const { ok, info } = await callVerify(store, mockReq, token!);
      expect(ok).toBe(true);
      expect((info as { redirectTo?: string }).redirectTo).toBe(redirectTo);
    });

    it('rejects a tampered token', async () => {
      const tampered = jwt.sign(
        { handle: 'x', createdAt: Date.now(), aud: 'github-oauth-state', iss: 'bike4mind' },
        'wrong-secret',
        { expiresIn: '5m', algorithm: 'HS256' }
      );
      const { err, ok, info } = await callVerify(store, mockReq, tampered);
      expect(err).toBeNull();
      expect(ok).toBe(false);
      expect((info as { message: string }).message).toBeDefined();
      expect((info as { code: string }).code).toBe('state_invalid');
    });

    it('rejects an expired token', async () => {
      const expired = jwt.sign(
        { handle: 'x', createdAt: Date.now(), aud: 'github-oauth-state', iss: 'bike4mind' },
        'test-jwt-secret-for-state-store',
        { expiresIn: '-1s', algorithm: 'HS256' }
      );
      const { err, ok, info } = await callVerify(store, mockReq, expired);
      expect(err).toBeNull();
      expect(ok).toBe(false);
      expect((info as { code: string }).code).toBe('state_expired');
    });

    it('rejects a token with wrong audience', async () => {
      const wrongAud = jwt.sign(
        { handle: 'x', createdAt: Date.now(), aud: 'google-oauth-state', iss: 'bike4mind' },
        'test-jwt-secret-for-state-store',
        { expiresIn: '5m', algorithm: 'HS256' }
      );
      const { err, ok, info } = await callVerify(store, mockReq, wrongAud);
      expect(err).toBeNull();
      expect(ok).toBe(false);
      expect((info as { code: string }).code).toBe('state_invalid');
    });

    it('rejects an empty state string', async () => {
      const { err, ok, info } = await callVerify(store, mockReq, '');
      expect(err).toBeNull();
      expect(ok).toBe(false);
      expect((info as { code: string }).code).toBe('state_missing');
    });
  });
});
