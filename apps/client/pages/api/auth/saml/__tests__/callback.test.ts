import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { createHash } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { AuthStrategy } from '@bike4mind/common';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
const captured = vi.hoisted(() => ({ handler: undefined as Handler | undefined }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: () => chain,
    get: (fn: Handler) => {
      captured.handler = fn;
      return chain;
    },
    post: () => chain,
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/checkBlockedIP', () => ({ checkBlockedIP: () => () => undefined }));

const mockSamlUser = vi.fn();
const mockSamlErr = vi.fn<() => Error | null>(() => null);
const mockSamlInfo = vi.fn<() => unknown>(() => ({}));
const mockAuthenticate = vi.hoisted(() => vi.fn());
vi.mock('passport', () => ({
  default: {
    authenticate: (_name: string, cb: (err: Error | null, user: unknown, info: unknown) => Promise<unknown>) => () => {
      mockAuthenticate();
      return cb(mockSamlErr(), mockSamlUser(), mockSamlInfo());
    },
  },
}));

vi.mock('@bike4mind/database', () => ({
  authFailLogRepository: { create: vi.fn() },
  identityProviderRepository: {
    findByIdWithSecrets: vi.fn().mockResolvedValue({ id: 'idp-1', isActive: true, type: 'saml' }),
    findActiveSamlIdpIdsByIssuer: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('@server/auth/auth', () => ({ setupSamlStrategy: () => 'saml-idp-1' }));
vi.mock('@server/auth/issueSession', () => ({
  issueBrowserSession: vi.fn().mockResolvedValue({ accessToken: 'access-token-canary' }),
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn() }));
const mockResolveSecondFactor = vi.hoisted(() => vi.fn());
vi.mock('@server/auth/signInSecondFactor', () => ({ resolveSecondFactor: mockResolveSecondFactor }));

const mockStampSourceTag = vi.fn().mockResolvedValue(undefined);
const mockRecordSignupAcquisition = vi.fn().mockResolvedValue({ isSynthetic: false });
const mockEmitSignupFunnelEvents = vi.fn().mockResolvedValue(undefined);
vi.mock('@server/utils/auth/oauthSourceTag', () => ({
  stampOAuthSourceTag: (...a: unknown[]) => mockStampSourceTag(...a),
}));
const mockRecordSignupNetwork = vi.fn().mockResolvedValue(undefined);
vi.mock('@server/auth/networkMeta', () => ({
  recordSignupNetwork: (...a: unknown[]) => mockRecordSignupNetwork(...a),
}));
const mockRefreshSignupRiskScore = vi.fn().mockResolvedValue(undefined);
vi.mock('@bike4mind/server-utils/auth/riskEvidence', () => ({
  requestRiskEvidenceRefresh: vi.fn(async () => 'queued'),
}));
vi.mock('@server/auth/signupRiskScore', () => ({
  refreshSignupRiskScore: (...a: unknown[]) => mockRefreshSignupRiskScore(...a),
}));
vi.mock('@server/analytics/funnel', () => ({
  recordSignupAcquisition: (...a: unknown[]) => mockRecordSignupAcquisition(...a),
  emitSignupFunnelEvents: (...a: unknown[]) => mockEmitSignupFunnelEvents(...a),
}));

import '../callback';

const AUTHORIZE_REDIRECT = '/oauth/authorize?client_id=b4m_sat_0123abcd&response_type=code';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const BROWSER_NONCE = 'browser-nonce';
const BROWSER_NONCE_HASH = createHash('sha256').update(BROWSER_NONCE).digest('hex');
const BROWSER_COOKIE = `b4m_saml_nonce=${BROWSER_NONCE}`;

/** Runs the callback as the browser that started the login: its nonce cookie and the matching `nh`. */
async function runCallback(relayState: string, redirectPattern: RegExp = /\/auth\/success/, body?: unknown) {
  const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
    method: 'GET',
    query: { RelayState: `${relayState}&nh=${BROWSER_NONCE_HASH}` },
    body: body as Record<string, unknown> | undefined,
    headers: { 'user-agent': 'UA/9', cookie: BROWSER_COOKIE },
  });
  Object.assign(req, { ip: '203.0.113.7', logger });
  await captured.handler!(req, res);
  await vi.waitFor(() => expect(res._getRedirectUrl()).toMatch(redirectPattern));
  return res;
}

describe('/api/auth/saml/callback - OAuth client source tag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSecondFactor.mockResolvedValue({ kind: 'satisfied', trustedDevice: null });
    mockSamlErr.mockReturnValue(null);
    mockSamlInfo.mockReturnValue({});
  });

  it('stamps a new account with the client_id from the authorize redirectTo', async () => {
    mockSamlUser.mockReturnValue({
      id: 'u-new',
      isBanned: false,
      isNewUser: true,
      emailVerified: true,
      signupCreditsGranted: 0,
    });
    const response = await runCallback(
      new URLSearchParams({ idp: 'idp-1', redirectTo: AUTHORIZE_REDIRECT }).toString()
    );
    expect(mockStampSourceTag).toHaveBeenCalledWith('u-new', 'b4m_sat_0123abcd');
    expect(mockRecordSignupNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-new', method: AuthStrategy.SAML })
    );
    expect(mockRefreshSignupRiskScore).toHaveBeenCalledWith('u-new', expect.anything());
    expect(mockRecordSignupNetwork.mock.invocationCallOrder[0]).toBeLessThan(
      mockRefreshSignupRiskScore.mock.invocationCallOrder[0]
    );
    expect(mockEmitSignupFunnelEvents).toHaveBeenCalledTimes(1);
    expect(mockEmitSignupFunnelEvents).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'saml', emailVerified: true, creditsGranted: 0 })
    );
    expect(response._getRedirectUrl()).toContain('firstSignupSession=1');
  });

  it("passes the new account's stored signupClientId to its signup event, null when it has none", async () => {
    mockSamlUser.mockReturnValue({ id: 'u-new', isBanned: false, isNewUser: true, signupClientId: 'b4m_sat_0123abcd' });
    await runCallback(new URLSearchParams({ idp: 'idp-1', redirectTo: AUTHORIZE_REDIRECT }).toString());
    expect(mockRecordSignupNetwork).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: 'u-new', clientId: 'b4m_sat_0123abcd' })
    );

    mockSamlUser.mockReturnValue({ id: 'u-new2', isBanned: false, isNewUser: true, signupClientId: null });
    await runCallback(new URLSearchParams({ idp: 'idp-1' }).toString());
    expect(mockRecordSignupNetwork).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: 'u-new2', clientId: null })
    );
  });

  it("carries a new account's verified hop, when its cookies reach the callback, to the signup funnel", async () => {
    // Usually they do not: the IdP's cross-site POST carries no Lax cookie. The write is the
    // shared one either way, so what it decides reaches signup_completed.
    const verifiedTouch = { srcProductId: 'source-product', hopId: 'c'.repeat(32), redeemedAt: new Date() };
    const acquisition = { verifiedTouch, signupMethod: 'saml', capturedAt: new Date() };
    mockRecordSignupAcquisition.mockResolvedValueOnce({ acquisition, isSynthetic: false });
    mockSamlUser.mockReturnValue({ id: 'u-new', isBanned: false, isNewUser: true, emailVerified: true });

    await runCallback(new URLSearchParams({ idp: 'idp-1', redirectTo: '/' }).toString());

    expect(mockRecordSignupAcquisition).toHaveBeenCalledWith(expect.objectContaining({ req: expect.anything() }));
    expect(mockEmitSignupFunnelEvents).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: 'u-new', acquisition }) })
    );
  });

  it('never stamps a returning user, even when redirectTo names a client', async () => {
    mockSamlUser.mockReturnValue({ id: 'u-old', isBanned: false });
    await runCallback(new URLSearchParams({ idp: 'idp-1', redirectTo: AUTHORIZE_REDIRECT }).toString());
    expect(mockStampSourceTag).not.toHaveBeenCalled();
    expect(mockRecordSignupNetwork).not.toHaveBeenCalled();
    expect(mockRefreshSignupRiskScore).not.toHaveBeenCalled();
  });

  it('passes no clientId when redirectTo is not an authorize path', async () => {
    mockSamlUser.mockReturnValue({ id: 'u-new', isBanned: false, isNewUser: true });
    await runCallback(new URLSearchParams({ idp: 'idp-1', redirectTo: '/settings?client_id=x' }).toString());
    expect(mockStampSourceTag).toHaveBeenCalledWith('u-new', undefined);
  });

  it('hands org-required enrollment to existing setup without issuing a session', async () => {
    mockSamlUser.mockReturnValue({ id: 'member', isBanned: false });
    mockResolveSecondFactor.mockResolvedValue({ kind: 'enroll', mfaToken: 'pending' });
    const res = await runCallback(new URLSearchParams({ idp: 'idp-1', redirectTo: '/new' }).toString());
    expect(res._getRedirectUrl()).toBe('/auth/success?redirectTo=%2Fnew#mfaToken=pending&userId=member&mfa=setup');
    expect(mockResolveSecondFactor).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      origin: { strategy: AuthStrategy.SAML, createdVia: 'saml' },
      enterpriseIdp: true,
    });
    const { issueBrowserSession } = await import('@server/auth/issueSession');
    expect(issueBrowserSession).not.toHaveBeenCalled();
  });
});

describe('/api/auth/saml/callback - structured logging', () => {
  const relay = new URLSearchParams({ idp: 'idp-1' }).toString();
  const loggedText = () =>
    JSON.stringify(Object.values(logger).flatMap(fn => fn.mock.calls.map(([message]) => message)));
  const loggedArguments = () => JSON.stringify(Object.values(logger).flatMap(fn => fn.mock.calls));

  beforeEach(() => {
    vi.clearAllMocks();
    mockSamlErr.mockReturnValue(null);
    mockSamlInfo.mockReturnValue({});
    mockResolveSecondFactor.mockResolvedValue({ kind: 'satisfied', trustedDevice: null });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('logs a signature failure once with the error as metadata and redirects as before', async () => {
    const err = new Error('invalid signature');
    mockSamlErr.mockReturnValue(err);
    mockSamlUser.mockReturnValue(undefined);

    const res = await runCallback(relay, /saml_signature_error/);

    expect(res._getRedirectUrl()).toBe('/login?error=saml_signature_error');
    const failures = logger.error.mock.calls.filter(([m]) => m === 'SAML signature validation failed');
    expect(failures).toHaveLength(1);
    expect(logger.error).toHaveBeenCalledWith(
      'SAML callback error',
      expect.objectContaining({ idpId: 'idp-1', error: err })
    );
    expect(loggedText()).not.toContain('invalid signature');
    expect(loggedText()).not.toContain('203.0.113.7');
    expect(console.error).not.toHaveBeenCalled();
  });

  it('logs the failure reason as metadata and keeps the email and IP out of the message', async () => {
    mockSamlUser.mockReturnValue(undefined);
    mockSamlInfo.mockReturnValue({ reason: 'domain_mismatch', email: 'person@example.com' });

    const res = await runCallback(relay, /saml_auth_failed/);

    expect(res._getRedirectUrl()).toBe('/login?error=saml_auth_failed');
    expect(logger.error).toHaveBeenCalledWith(
      'SAML authentication failed',
      expect.objectContaining({ idpId: 'idp-1', reason: 'domain_mismatch' })
    );
    expect(loggedArguments()).not.toContain('person@example.com');
    expect(loggedArguments()).not.toContain('203.0.113.7');
    expect(console.error).not.toHaveBeenCalled();
  });

  it('keeps the SAMLResponse, access token and email out of every logger argument', async () => {
    const samlResponse = 'PHNhbWxwOlJlc3BvbnNlLXNpZ25lZA==';
    const canaryRelay = new URLSearchParams({ idp: 'idp-1', marker: 'relay-canary-93' }).toString();
    mockSamlUser.mockReturnValue({ id: 'u-1', isBanned: false, email: 'person@example.com' });
    mockSamlInfo.mockReturnValue({ email: 'info-person@example.com' });

    await runCallback(canaryRelay, /\/auth\/success/, { SAMLResponse: samlResponse, RelayState: canaryRelay });

    const everything = loggedArguments();
    expect(everything).not.toContain('relay-canary-93');
    expect(everything).not.toContain('info-person@example.com');
    expect(everything).not.toContain(samlResponse);
    expect(everything).not.toContain('access-token-canary');
    expect(everything).not.toContain('person@example.com');
  });
});

describe('/api/auth/saml/callback - callbacks naming no usable IdP', () => {
  async function runWithQuery(query: Record<string, string | string[]>) {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: 'GET',
      query,
      headers: { 'user-agent': 'UA/9' },
    });
    Object.assign(req, { ip: '203.0.113.7', logger });
    await captured.handler!(req, res);
    return res;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redirects a repeated RelayState to the login page without an error log', async () => {
    const res = await runWithQuery({ RelayState: ['a', 'b'] });

    expect(res._getRedirectUrl()).toBe('/login?error=missing_idp_context');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('redirects an unknown IdP to the login page without an error log', async () => {
    const { identityProviderRepository } = await import('@bike4mind/database');
    vi.mocked(identityProviderRepository.findByIdWithSecrets).mockResolvedValueOnce(null);

    const res = await runWithQuery({ RelayState: 'idp=not-an-idp' });

    expect(res._getRedirectUrl()).toBe('/login?error=invalid_idp');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('still logs an unexpected failure (DB) at error', async () => {
    const { identityProviderRepository } = await import('@bike4mind/database');
    vi.mocked(identityProviderRepository.findByIdWithSecrets).mockRejectedValueOnce(new Error('db down'));

    const res = await runWithQuery({ RelayState: 'idp=idp-1' });

    expect(res._getRedirectUrl()).toBe('/login?error=callback_error');
    expect(logger.error).toHaveBeenCalledWith('SAML callback processing error', expect.anything());
  });
});

describe('/api/auth/saml/callback - choosing the IdP', () => {
  const ISSUER = 'https://idp.a.example/metadata';
  const samlResponse = (issuer: string) =>
    Buffer.from(
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"><saml:Issuer>${issuer}</saml:Issuer></samlp:Response>`
    ).toString('base64');

  async function post(body: Record<string, unknown>, query: Record<string, string> = {}, cookie = '') {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: 'POST',
      body,
      query,
      headers: { 'user-agent': 'UA/9', cookie },
    });
    Object.assign(req, { ip: '203.0.113.7', logger });
    await captured.handler!(req, res);
    await vi.waitFor(() => expect(res._getRedirectUrl()).not.toBe(''));
    return res;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSecondFactor.mockResolvedValue({ kind: 'satisfied', trustedDevice: null });
    mockSamlErr.mockReturnValue(null);
    mockSamlInfo.mockReturnValue({});
    mockSamlUser.mockReturnValue({ id: 'u1', isBanned: false, isNewUser: false });
  });

  it('restarts an IdP-initiated response as a login from this browser at the IdP its Issuer names', async () => {
    const { identityProviderRepository } = await import('@bike4mind/database');
    vi.mocked(identityProviderRepository.findActiveSamlIdpIdsByIssuer).mockResolvedValueOnce(['idp-1']);

    const res = await post({ SAMLResponse: samlResponse(ISSUER) });

    expect(identityProviderRepository.findActiveSamlIdpIdsByIssuer).toHaveBeenCalledWith(ISSUER);
    expect(identityProviderRepository.findByIdWithSecrets).toHaveBeenCalledWith('idp-1');
    expect(res._getRedirectUrl()).toBe('/api/auth/saml?idp=idp-1');
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  it('uses the IdP named in RelayState without looking the Issuer up', async () => {
    const { identityProviderRepository } = await import('@bike4mind/database');

    const res = await post(
      { RelayState: `idp=idp-1&nh=${BROWSER_NONCE_HASH}`, SAMLResponse: samlResponse(ISSUER) },
      {},
      BROWSER_COOKIE
    );

    expect(identityProviderRepository.findActiveSamlIdpIdsByIssuer).not.toHaveBeenCalled();
    expect(identityProviderRepository.findByIdWithSecrets).toHaveBeenCalledWith('idp-1');
    expect(res._getRedirectUrl()).toContain('/auth/success');
  });

  it.each([
    ['several active IdPs share the Issuer', ['idp-1', 'idp-2']],
    ['no active IdP has the Issuer', []],
  ])('refuses an IdP-initiated response when %s', async (_label, matches) => {
    const { identityProviderRepository } = await import('@bike4mind/database');
    vi.mocked(identityProviderRepository.findActiveSamlIdpIdsByIssuer).mockResolvedValueOnce(matches);

    const res = await post({ SAMLResponse: samlResponse(ISSUER) });

    expect(res._getRedirectUrl()).toBe('/login?error=missing_idp_context');
    expect(identityProviderRepository.findByIdWithSecrets).not.toHaveBeenCalled();
  });

  it('ignores an idp query parameter', async () => {
    const { identityProviderRepository } = await import('@bike4mind/database');

    const res = await post({}, { idp: 'idp-1' });

    expect(res._getRedirectUrl()).toBe('/login?error=missing_idp_context');
    expect(identityProviderRepository.findByIdWithSecrets).not.toHaveBeenCalled();
  });
});

describe('/api/auth/saml/callback - browser binding', () => {
  async function post(relayState: string, cookie: string) {
    const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
      method: 'POST',
      body: { RelayState: relayState, SAMLResponse: 'opaque' },
      headers: { 'user-agent': 'UA/9', cookie },
    });
    Object.assign(req, { ip: '203.0.113.7', logger });
    await captured.handler!(req, res);
    await vi.waitFor(() => expect(res._getRedirectUrl()).not.toBe(''));
    return res;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSecondFactor.mockResolvedValue({ kind: 'satisfied', trustedDevice: null });
    mockSamlErr.mockReturnValue(null);
    mockSamlInfo.mockReturnValue({});
    mockSamlUser.mockReturnValue({ id: 'u1', isBanned: false, isNewUser: false });
  });

  it.each([
    ['no nonce cookie', ''],
    ["another browser's nonce cookie", 'b4m_saml_nonce=other-browser'],
  ])('signs nobody in when a bound response arrives with %s', async (_label, cookie) => {
    const { issueBrowserSession } = await import('@server/auth/issueSession');

    const res = await post(`idp=idp-1&nh=${BROWSER_NONCE_HASH}`, cookie);

    expect(res._getRedirectUrl()).toBe('/login?error=saml_session_mismatch');
    expect(mockAuthenticate).not.toHaveBeenCalled();
    expect(issueBrowserSession).not.toHaveBeenCalled();
  });

  it('restarts a response with no binding instead of signing it in, keeping redirectTo', async () => {
    const { issueBrowserSession } = await import('@server/auth/issueSession');

    const res = await post('idp=idp-1&redirectTo=%2Fnotebooks', BROWSER_COOKIE);

    expect(res._getRedirectUrl()).toBe('/api/auth/saml?idp=idp-1&redirectTo=%2Fnotebooks');
    expect(mockAuthenticate).not.toHaveBeenCalled();
    expect(issueBrowserSession).not.toHaveBeenCalled();
  });

  it('signs in the browser that started the login and expires its nonce cookie', async () => {
    const res = await post(`idp=idp-1&nh=${BROWSER_NONCE_HASH}`, BROWSER_COOKIE);

    expect(res._getRedirectUrl()).toContain('/auth/success');
    expect(res.getHeader('Set-Cookie')).toEqual(expect.stringMatching(/^b4m_saml_nonce=; .*Max-Age=0/));
  });
});
