// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import crypto from 'crypto';

const CLIENT_SECRET = 'client-secret-xyz';
const REDIRECT_URI = 'https://redirect.example/cb-secret';

const { JWT_SECRET, mockFindById, mockReadStateNonceHash, mockClearStateNonce, mockAuditSuccess, mockAuditFailure } =
  vi.hoisted(() => ({
    JWT_SECRET: 'test-secret',
    mockFindById: vi.fn(),
    mockReadStateNonceHash: vi.fn(),
    mockClearStateNonce: vi.fn(),
    mockAuditSuccess: vi.fn(),
    mockAuditFailure: vi.fn(),
  }));

const mockLogger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }));

/** Every log arg as text, with Errors expanded: JSON.stringify renders an Error as {}. */
const loggedText = () =>
  JSON.stringify(
    [mockLogger.error.mock.calls, mockLogger.warn.mock.calls, mockLogger.info.mock.calls],
    (_key, value) => (value instanceof Error ? { message: value.message, stack: value.stack } : value)
  );

const expectNoSecretsLogged = (secrets: string[]) => {
  const logged = loggedText();
  for (const secret of secrets) expect(logged).not.toContain(secret);
};

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) =>
        h[(req as { method?: string }).method ?? 'GET']?.(Object.assign(req as object, { logger: mockLogger }), res),
      {
        use: () => chain,
        get: (fn: (req: unknown, res: unknown) => unknown) => ((h.GET = fn), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: (...a: unknown[]) => mockFindById(...a), update: vi.fn() },
}));
vi.mock('@bike4mind/server-utils/integrations/jira/atlassianConfig', () => ({
  getAtlassianOAuthConfig: vi.fn(async () => ({
    clientId: 'c',
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
  })),
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { JWT_SECRET } }));
vi.mock('@bike4mind/server-utils/auth/oauthFlowCookie', () => ({
  readStateNonceHash: (...a: unknown[]) => mockReadStateNonceHash(...a),
  clearStateNonce: (...a: unknown[]) => mockClearStateNonce(...a),
}));
vi.mock('@bike4mind/server-utils/integrations/integrationAuditLogger', () => ({
  IntegrationAuditLogger: {
    create: () => ({
      setUserId: vi.fn(),
      success: (...a: unknown[]) => mockAuditSuccess(...a),
      failure: (...a: unknown[]) => mockAuditFailure(...a),
    }),
  },
}));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({ encryptToken: (t: string) => t }));

import handler from '../callback';

const USER_ID = 'user-1';
const NONCE_HASH = 'nonce-hash';

/** The state this handler's own connect step emits: signed over the same four fields. */
const signedState = () => {
  const csrfToken = 'csrf';
  const timestamp = Date.now();
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${USER_ID}:${csrfToken}:${timestamp}:${NONCE_HASH}`)
    .digest('hex');
  return JSON.stringify({ userId: USER_ID, csrfToken, timestamp, nonceHash: NONCE_HASH, signature });
};

const run = async () => {
  const { req, res } = createMocks({ method: 'GET', query: { code: 'auth-code', state: signedState() } });
  await (handler as unknown as (rq: unknown, rs: unknown) => Promise<void>)(req, res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/mcp-servers/atlassian/callback - duplicate delivery', () => {
  it('reports the existing connection when the nonce cookie is already burned', async () => {
    // The first callback clears the cookie, so a refresh or Back through this handler arrives with
    // none. Gating that on the nonce would show an error banner - and write a session_mismatch
    // audit row - for a link that is live.
    mockReadStateNonceHash.mockReturnValue(null);
    mockFindById.mockResolvedValue({ atlassianConnect: { status: 'connected' } });

    const res = await run();

    expect(res._getRedirectUrl()).toBe('/profile?tab=integrations&atlassian=connected');
    expect(mockAuditSuccess).toHaveBeenCalledWith({ isDuplicate: true });
    expect(mockAuditFailure).not.toHaveBeenCalled();
  });

  it('still fails closed on a missing nonce when there is no connection to restate', async () => {
    // The binding itself is unchanged: only an already-connected user skips it, and that branch
    // exchanges nothing and grants nothing.
    mockReadStateNonceHash.mockReturnValue(null);
    mockFindById.mockResolvedValue({ atlassianConnect: { status: 'pending' } });

    const res = await run();

    expect(res._getRedirectUrl()).toBe('/profile?tab=integrations&atlassian=error');
    expect(mockAuditFailure).toHaveBeenCalledWith('session_mismatch');
  });
});

describe('GET /api/mcp-servers/atlassian/callback - malformed state', () => {
  it('rejects a non-JSON state at warn level so caller junk does not raise an alert', async () => {
    const errorSpy = mockLogger.error;
    const warnSpy = mockLogger.warn;
    const { req, res } = createMocks({ method: 'GET', query: { code: 'auth-code', state: 'y' } });

    await (handler as unknown as (rq: unknown, rs: unknown) => Promise<void>)(req, res);

    expect(res._getRedirectUrl()).toBe('/profile?tab=integrations&atlassian=error');
    expect(mockAuditFailure).toHaveBeenCalledWith('invalid_state');
    expect(warnSpy).toHaveBeenCalledWith('Atlassian callback state parameter could not be parsed', {
      error: expect.any(SyntaxError),
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('rejects a state that is absent entirely at warn level', async () => {
    const errorSpy = mockLogger.error;
    const warnSpy = mockLogger.warn;
    const { req, res } = createMocks({ method: 'GET', query: { code: 'auth-code' } });

    await (handler as unknown as (rq: unknown, rs: unknown) => Promise<void>)(req, res);

    expect(res._getRedirectUrl()).toBe('/profile?tab=integrations&atlassian=error');
    expect(mockAuditFailure).toHaveBeenCalledWith('missing_state');
    expect(warnSpy).toHaveBeenCalledWith('Atlassian callback missing state parameter');
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('GET /api/mcp-servers/atlassian/callback - authorization not completed', () => {
  const call = async (query: Record<string, string>) => {
    const { req, res } = createMocks({ method: 'GET', query });
    await (handler as unknown as (rq: unknown, rs: unknown) => Promise<void>)(req, res);
    return res;
  };

  it('logs a declined consent at warn with only the RFC 6749 code', async () => {
    const errorSpy = mockLogger.error;
    const warnSpy = mockLogger.warn;

    const res = await call({ error: 'access_denied', state: 'opaque-state' });

    expect(res._getRedirectUrl()).toBe('/profile?tab=integrations&atlassian=error');
    expect(mockAuditFailure).toHaveBeenCalledWith('oauth_error');
    expect(warnSpy).toHaveBeenCalledWith('Atlassian authorization not completed', {
      error: 'access_denied',
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs a callback with no code at all at warn', async () => {
    const errorSpy = mockLogger.error;
    const warnSpy = mockLogger.warn;

    const res = await call({});

    expect(res._getRedirectUrl()).toBe('/profile?tab=integrations&atlassian=error');
    expect(mockAuditFailure).toHaveBeenCalledWith('missing_code');
    expect(warnSpy).toHaveBeenCalledWith('Atlassian callback missing authorization code');
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

const AUTH_CODE_SECRETS = ['auth-code', CLIENT_SECRET, 'redirect.example', 'cb-secret'];

describe('GET /api/mcp-servers/atlassian/callback - token exchange failure', () => {
  it('logs only the status, never the code, response body, redirect_uri or client secret', async () => {
    mockReadStateNonceHash.mockReturnValue(NONCE_HASH);
    mockFindById.mockResolvedValue({ atlassianConnect: { status: 'pending' } });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('provider-body-secret', { status: 400 }));

    const res = await run();
    fetchSpy.mockRestore();

    expect(res._getRedirectUrl()).toBe('/profile?tab=integrations&atlassian=error');
    expect(mockLogger.error).toHaveBeenCalledWith('Atlassian token exchange failed', {
      userId: USER_ID,
      status: 400,
    });
    expectNoSecretsLogged([...AUTH_CODE_SECRETS, 'provider-body-secret']);
  });
});

describe('GET /api/mcp-servers/atlassian/callback - later branches', () => {
  const tokens = () =>
    new Response(
      JSON.stringify({ access_token: 'access-token-xyz', refresh_token: 'refresh-token-xyz', expires_in: 3600 }),
      {
        status: 200,
      }
    );
  const secrets = [...AUTH_CODE_SECRETS, 'access-token-xyz', 'refresh-token-xyz', 'resources-body-secret'];

  beforeEach(() => {
    mockReadStateNonceHash.mockReturnValue(NONCE_HASH);
    mockFindById.mockResolvedValue({ atlassianConnect: { status: 'pending' } });
  });

  it('logs no token or code when the accessible-resources fetch fails', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(tokens())
      .mockResolvedValueOnce(new Response('resources-body-secret', { status: 500 }));

    await run();
    fetchSpy.mockRestore();

    expect(mockLogger.error).toHaveBeenCalledWith('Atlassian accessible-resources fetch failed', {
      userId: USER_ID,
      status: 500,
    });
    expectNoSecretsLogged(secrets);
  });

  it('logs no token or code on success', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(tokens())
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 'site-1', name: 'n', scopes: [] }]), { status: 200 }));

    await run();
    fetchSpy.mockRestore();

    expect(mockLogger.info).toHaveBeenCalledWith(
      'Atlassian tokens stored',
      expect.objectContaining({ userId: USER_ID })
    );
    expectNoSecretsLogged(secrets);
  });
});
