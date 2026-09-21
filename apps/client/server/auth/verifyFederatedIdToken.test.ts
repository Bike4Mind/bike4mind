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

describe('verifyFederatedIdToken', () => {
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

  it('caches one verifier per trust config (no re-fetch of JWKS across calls)', async () => {
    mockVerify.mockResolvedValue({ token_use: 'id', identities: [{ userId: 'u', providerName: 'B4M' }] });

    await verifyFederatedIdToken('tok1', IDP);
    await verifyFederatedIdToken('tok2', IDP);

    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

// Shape 2: the app signed its user in against B4M's own OIDC provider, so the token is
// one B4M issued and the user id is its `sub`. Claim set mirrors generateIdToken.
const B4M_IDP = {
  issuer: 'https://app.example-b4m.test',
  audience: 'b4m_tarot_abcd1234',
  jwksUri: 'https://app.example-b4m.test/api/oauth/jwks',
  subjectSource: 'sub' as const,
};

describe('verifyFederatedIdToken - B4M-issued ID token (subjectSource: sub)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockImplementation(() => ({ verify: mockVerify }));
    __clearVerifierCache();
  });

  it('resolves the B4M user id from sub, with no token_use claim present', async () => {
    mockVerify.mockResolvedValue({
      iss: B4M_IDP.issuer,
      sub: 'b4m-user-777',
      aud: B4M_IDP.audience,
      email: 'u@example.test',
      name: 'u',
    });

    const result = await verifyFederatedIdToken('tok', B4M_IDP);

    expect(result.b4mUserId).toBe('b4m-user-777');
    expect(mockCreate).toHaveBeenCalledWith({
      issuer: B4M_IDP.issuer,
      audience: B4M_IDP.audience,
      jwksUri: B4M_IDP.jwksUri,
    });
  });

  it('ignores an identities claim and never requires providerName', async () => {
    mockVerify.mockResolvedValue({
      sub: 'b4m-user-777',
      identities: [{ userId: 'someone-else', providerName: 'B4M' }],
    });

    const result = await verifyFederatedIdToken('tok', B4M_IDP);
    expect(result.b4mUserId).toBe('b4m-user-777');
  });

  it('rejects a wrong-issuer / wrong-audience / expired token (verifier throws)', async () => {
    mockVerify.mockRejectedValue(new Error('Issuer not allowed'));
    await expect(verifyFederatedIdToken('tok', B4M_IDP)).rejects.toBeInstanceOf(FederatedIdTokenError);
  });

  it('rejects a B4M session access token presented as an ID token', async () => {
    // AuthTokenGeneratorService.signAccessToken's payload shape. In production such a
    // token never reaches this check (HS256, no iss/aud), so this guards the guard.
    mockVerify.mockResolvedValue({ id: 'b4m-user-777', sub: 'b4m-user-777', tokenVersion: 0, typ: 'access' });
    await expect(verifyFederatedIdToken('tok', B4M_IDP)).rejects.toBeInstanceOf(FederatedIdTokenError);
  });

  it('rejects a refresh token presented as an ID token', async () => {
    mockVerify.mockResolvedValue({ sub: 'b4m-user-777', typ: 'refresh' });
    await expect(verifyFederatedIdToken('tok', B4M_IDP)).rejects.toBeInstanceOf(FederatedIdTokenError);
  });

  it('rejects a token with no usable sub', async () => {
    mockVerify.mockResolvedValue({ iss: B4M_IDP.issuer, aud: B4M_IDP.audience });
    await expect(verifyFederatedIdToken('tok', B4M_IDP)).rejects.toBeInstanceOf(FederatedIdTokenError);
  });

  it("an explicit subjectSource: 'identities' behaves exactly like an absent one", async () => {
    mockVerify.mockResolvedValue({
      token_use: 'id',
      sub: 'cognito-native-sub',
      identities: [{ userId: 'b4m-user-123', providerName: 'B4M' }],
    });

    const result = await verifyFederatedIdToken('tok', { ...IDP, subjectSource: 'identities' as const });
    // sub is the Cognito pool's own subject, NOT the B4M user - the identities entry wins.
    expect(result.b4mUserId).toBe('b4m-user-123');
  });

  it("rejects an 'identities' client whose trust config is missing providerName", async () => {
    mockVerify.mockResolvedValue({ token_use: 'id', identities: [{ userId: 'u', providerName: 'B4M' }] });
    const { providerName: _omitted, ...withoutProvider } = IDP;
    await expect(verifyFederatedIdToken('tok', withoutProvider)).rejects.toBeInstanceOf(FederatedIdTokenError);
  });
});

describe('verifyCognitoIdToken - staged subjectSource=sub requirement (OAUTH_AI_TOKEN_REQUIRE_SUB)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockImplementation(() => ({ verify: mockVerify }));
    __clearVerifierCache();
    delete process.env.OAUTH_AI_TOKEN_REQUIRE_SUB;
  });
  afterEach(() => {
    delete process.env.OAUTH_AI_TOKEN_REQUIRE_SUB;
  });

  it('enforce mode rejects an identities-source client', async () => {
    process.env.OAUTH_AI_TOKEN_REQUIRE_SUB = 'true';
    mockVerify.mockResolvedValue({
      token_use: 'id',
      identities: [{ userId: 'b4m-user-123', providerName: 'B4M' }],
    });
    await expect(verifyCognitoIdToken('tok', IDP)).rejects.toBeInstanceOf(CognitoIdTokenError);
  });

  it('grace mode (flag unset) still resolves an identities-source client but logs a would-reject', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockVerify.mockResolvedValue({
      token_use: 'id',
      identities: [{ userId: 'b4m-user-123', providerName: 'B4M' }],
    });

    const result = await verifyCognitoIdToken('tok', IDP);

    expect(result.b4mUserId).toBe('b4m-user-123');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('would-reject'));
    warn.mockRestore();
  });

  it('enforce mode does not affect a subjectSource=sub client', async () => {
    process.env.OAUTH_AI_TOKEN_REQUIRE_SUB = 'true';
    mockVerify.mockResolvedValue({ sub: 'b4m-user-777' });

    const result = await verifyCognitoIdToken('tok', B4M_IDP);
    expect(result.b4mUserId).toBe('b4m-user-777');
  });
});
