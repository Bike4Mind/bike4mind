import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub aws-jwt-verify: JwtVerifier.create returns a verifier whose verify() we drive per-test.
const mockVerify = vi.fn();
const mockCreate = vi.fn(() => ({ verify: mockVerify }));
vi.mock('aws-jwt-verify', () => ({
  JwtVerifier: { create: (...args: any[]) => mockCreate(...args) },
}));

import { verifyCognitoIdToken, CognitoIdTokenError, __clearVerifierCache } from './verifyCognitoIdToken';

const IDP = {
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool',
  audience: 'cognito-app-client-id',
  providerName: 'B4M',
};

describe('verifyCognitoIdToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockImplementation(() => ({ verify: mockVerify }));
    __clearVerifierCache();
  });

  it('resolves the B4M user id from a valid ID token', async () => {
    mockVerify.mockResolvedValue({
      token_use: 'id',
      identities: [{ userId: 'b4m-user-123', providerName: 'B4M' }],
    });

    const result = await verifyCognitoIdToken('tok', IDP);

    expect(result.b4mUserId).toBe('b4m-user-123');
    expect(mockCreate).toHaveBeenCalledWith({ issuer: IDP.issuer, audience: IDP.audience });
  });

  it('parses a JSON-string identities claim', async () => {
    mockVerify.mockResolvedValue({
      token_use: 'id',
      identities: JSON.stringify([{ userId: 'b4m-user-str', providerName: 'B4M' }]),
    });

    const result = await verifyCognitoIdToken('tok', IDP);
    expect(result.b4mUserId).toBe('b4m-user-str');
  });

  it('passes jwksUri through to the verifier when configured', async () => {
    mockVerify.mockResolvedValue({ token_use: 'id', identities: [{ userId: 'u', providerName: 'B4M' }] });
    const jwksUri = 'https://example.com/keys';

    await verifyCognitoIdToken('tok', { ...IDP, jwksUri });
    expect(mockCreate).toHaveBeenCalledWith({ issuer: IDP.issuer, audience: IDP.audience, jwksUri });
  });

  it('throws when signature/claim verification fails', async () => {
    mockVerify.mockRejectedValue(new Error('signature invalid'));
    await expect(verifyCognitoIdToken('tok', IDP)).rejects.toBeInstanceOf(CognitoIdTokenError);
  });

  it("rejects a non-'id' token_use (e.g. an access token)", async () => {
    mockVerify.mockResolvedValue({
      token_use: 'access',
      identities: [{ userId: 'u', providerName: 'B4M' }],
    });
    await expect(verifyCognitoIdToken('tok', IDP)).rejects.toBeInstanceOf(CognitoIdTokenError);
  });

  it('rejects when no identity matches the configured providerName', async () => {
    mockVerify.mockResolvedValue({
      token_use: 'id',
      identities: [{ userId: 'u', providerName: 'SomeOtherIdp' }],
    });
    await expect(verifyCognitoIdToken('tok', IDP)).rejects.toBeInstanceOf(CognitoIdTokenError);
  });

  it('rejects when the identities claim is absent', async () => {
    mockVerify.mockResolvedValue({ token_use: 'id' });
    await expect(verifyCognitoIdToken('tok', IDP)).rejects.toBeInstanceOf(CognitoIdTokenError);
  });

  it('caches one verifier per trust config (no re-fetch of JWKS across calls)', async () => {
    mockVerify.mockResolvedValue({ token_use: 'id', identities: [{ userId: 'u', providerName: 'B4M' }] });

    await verifyCognitoIdToken('tok1', IDP);
    await verifyCognitoIdToken('tok2', IDP);

    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
