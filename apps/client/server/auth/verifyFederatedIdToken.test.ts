import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub aws-jwt-verify: JwtVerifier.create returns a verifier whose verify() we drive per-test.
const mockVerify = vi.fn();
const mockCreate = vi.fn(() => ({ verify: mockVerify }));
vi.mock('aws-jwt-verify', () => ({
  JwtVerifier: { create: (...args: any[]) => mockCreate(...args) },
}));

import { verifyFederatedIdToken, FederatedIdTokenError, __clearVerifierCache } from './verifyFederatedIdToken';

const IDP = {
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool',
  audience: 'cognito-app-client-id',
  providerName: 'B4M',
};

const APP_URL = 'https://app.example.com';

const B4M_IDP = {
  issuer: APP_URL,
  audience: 'b4m-oauth-client-id',
  jwksUri: `${APP_URL}/api/oauth/jwks`,
};

describe('verifyFederatedIdToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockImplementation(() => ({ verify: mockVerify }));
    __clearVerifierCache();
  });

  describe('external Cognito issuer', () => {
    it('resolves the B4M user id from a valid ID token', async () => {
      mockVerify.mockResolvedValue({
        token_use: 'id',
        identities: [{ userId: 'b4m-user-123', providerName: 'B4M' }],
      });

      const result = await verifyFederatedIdToken('tok', IDP);

      expect(result.b4mUserId).toBe('b4m-user-123');
      expect(mockCreate).toHaveBeenCalledWith({ issuer: IDP.issuer, audience: IDP.audience });
    });

    it('parses a JSON-string identities claim', async () => {
      mockVerify.mockResolvedValue({
        token_use: 'id',
        identities: JSON.stringify([{ userId: 'b4m-user-str', providerName: 'B4M' }]),
      });

      const result = await verifyFederatedIdToken('tok', IDP);
      expect(result.b4mUserId).toBe('b4m-user-str');
    });

    it('passes jwksUri through to the verifier when configured', async () => {
      mockVerify.mockResolvedValue({ token_use: 'id', identities: [{ userId: 'u', providerName: 'B4M' }] });
      const jwksUri = 'https://example.com/keys';

      await verifyFederatedIdToken('tok', { ...IDP, jwksUri });
      expect(mockCreate).toHaveBeenCalledWith({ issuer: IDP.issuer, audience: IDP.audience, jwksUri });
    });

    it('throws when signature/claim verification fails', async () => {
      mockVerify.mockRejectedValue(new Error('signature invalid'));
      await expect(verifyFederatedIdToken('tok', IDP)).rejects.toBeInstanceOf(FederatedIdTokenError);
    });

    it("rejects a non-'id' token_use (e.g. an access token)", async () => {
      mockVerify.mockResolvedValue({
        token_use: 'access',
        identities: [{ userId: 'u', providerName: 'B4M' }],
      });
      await expect(verifyFederatedIdToken('tok', IDP)).rejects.toBeInstanceOf(FederatedIdTokenError);
    });

    it('rejects when no identity matches the configured providerName', async () => {
      mockVerify.mockResolvedValue({
        token_use: 'id',
        identities: [{ userId: 'u', providerName: 'SomeOtherIdp' }],
      });
      await expect(verifyFederatedIdToken('tok', IDP)).rejects.toBeInstanceOf(FederatedIdTokenError);
    });

    it('rejects when the identities claim is absent', async () => {
      mockVerify.mockResolvedValue({ token_use: 'id' });
      await expect(verifyFederatedIdToken('tok', IDP)).rejects.toBeInstanceOf(FederatedIdTokenError);
    });

    it('rejects a trust config with no providerName (never falls back to sub)', async () => {
      mockVerify.mockResolvedValue({ token_use: 'id', sub: 'b4m-user-1' });
      const { providerName: _omitted, ...withoutProvider } = IDP;
      await expect(verifyFederatedIdToken('tok', withoutProvider)).rejects.toBeInstanceOf(FederatedIdTokenError);
    });

    it('caches one verifier per trust config (no re-fetch of JWKS across calls)', async () => {
      mockVerify.mockResolvedValue({ token_use: 'id', identities: [{ userId: 'u', providerName: 'B4M' }] });

      await verifyFederatedIdToken('tok1', IDP);
      await verifyFederatedIdToken('tok2', IDP);

      expect(mockCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe('B4M as issuer', () => {
    const originalAppUrl = process.env.APP_URL;

    beforeEach(() => {
      process.env.APP_URL = APP_URL;
    });

    afterEach(() => {
      if (originalAppUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = originalAppUrl;
    });

    it('resolves the user id from sub, with no token_use or identities claim', async () => {
      mockVerify.mockResolvedValue({ sub: 'b4m-user-9', email: 'a@b.test' });

      const result = await verifyFederatedIdToken('tok', B4M_IDP);

      expect(result.b4mUserId).toBe('b4m-user-9');
      expect(mockCreate).toHaveBeenCalledWith({
        issuer: B4M_IDP.issuer,
        audience: B4M_IDP.audience,
        jwksUri: B4M_IDP.jwksUri,
      });
    });

    it('matches the issuer regardless of a trailing slash on APP_URL', async () => {
      process.env.APP_URL = `${APP_URL}/`;
      mockVerify.mockResolvedValue({ sub: 'b4m-user-9' });

      await expect(verifyFederatedIdToken('tok', B4M_IDP)).resolves.toMatchObject({ b4mUserId: 'b4m-user-9' });
    });

    it('requires an explicit jwksUri rather than deriving one', async () => {
      const { jwksUri: _omitted, ...withoutJwks } = B4M_IDP;

      await expect(verifyFederatedIdToken('tok', withoutJwks)).rejects.toBeInstanceOf(FederatedIdTokenError);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('rejects an expired / wrong-audience / wrong-issuer token via the verifier', async () => {
      mockVerify.mockRejectedValue(new Error('Token expired'));
      await expect(verifyFederatedIdToken('tok', B4M_IDP)).rejects.toBeInstanceOf(FederatedIdTokenError);
    });

    it('rejects a B4M access token: HS256 session JWTs carry no JWKS key', async () => {
      mockVerify.mockRejectedValue(new Error('Invalid signature'));
      await expect(verifyFederatedIdToken('b4m-access-token', B4M_IDP)).rejects.toBeInstanceOf(FederatedIdTokenError);
    });

    it('rejects a verified token with no usable sub', async () => {
      mockVerify.mockResolvedValue({ email: 'a@b.test' });
      await expect(verifyFederatedIdToken('tok', B4M_IDP)).rejects.toBeInstanceOf(FederatedIdTokenError);
    });

    it('fails closed when APP_URL is unset: the config is treated as external', async () => {
      delete process.env.APP_URL;
      mockVerify.mockResolvedValue({ sub: 'b4m-user-9' });

      // No token_use and no providerName, so the external branch rejects it.
      await expect(verifyFederatedIdToken('tok', B4M_IDP)).rejects.toBeInstanceOf(FederatedIdTokenError);
    });
  });
});
