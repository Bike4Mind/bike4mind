// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import crypto from 'crypto';

const CLIENT_SECRET = 'client-secret-xyz';
const REDIRECT_URI = 'https://redirect.example/cb-secret';

const { mockAuditFailure } = vi.hoisted(() => ({ mockAuditFailure: vi.fn() }));

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

const mockUpdateMany = vi.hoisted(() => vi.fn());

vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: vi.fn(), update: vi.fn(), updateMany: mockUpdateMany },
}));
vi.mock('@server/integrations/notion', () => ({
  getNotionOAuthConfig: vi.fn(async () => ({ clientId: 'c', clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI })),
  NOTION_OAUTH_TOKEN_URL: 'https://api.notion.com/v1/oauth/token',
  NOTION_API_BASE_URL: 'https://api.notion.com/v1',
  NOTION_VERSION: '2022-06-28',
}));
vi.mock('@server/integrations/notion/notionTokenManager', () => ({ NotionTokenManager: class {} }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { JWT_SECRET: 'test-secret' } }));
vi.mock('@bike4mind/server-utils/integrations/integrationAuditLogger', () => ({
  IntegrationAuditLogger: {
    create: () => ({
      setUserId: vi.fn(),
      success: vi.fn(),
      failure: (...a: unknown[]) => mockAuditFailure(...a),
    }),
  },
}));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({ encryptToken: (t: string) => t }));

import handler from '../callback';

const BROWSER_NONCE = 'browser-nonce';
const BROWSER_COOKIE = `b4m_oauth_nonce_notion-connect=${BROWSER_NONCE}`;

const call = async (query: Record<string, string>, cookie: string = BROWSER_COOKIE) => {
  const { req, res } = createMocks({ method: 'GET', query, headers: { cookie } });
  await (handler as unknown as (rq: unknown, rs: unknown) => Promise<void>)(req, res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/mcp-servers/notion/callback - malformed state', () => {
  it('rejects a non-JSON state at warn level so caller junk does not raise an alert', async () => {
    const errorSpy = mockLogger.error;
    const warnSpy = mockLogger.warn;

    const res = await call({ code: 'auth-code', state: 'y' });

    expect(res._getRedirectUrl()).toBe('/profile?tab=integrations&notion=error');
    expect(mockAuditFailure).toHaveBeenCalledWith('invalid_state');
    expect(warnSpy).toHaveBeenCalledWith('Notion callback state parameter could not be parsed', {
      error: expect.any(SyntaxError),
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('rejects a state that is absent entirely at warn level', async () => {
    const errorSpy = mockLogger.error;
    const warnSpy = mockLogger.warn;

    const res = await call({ code: 'auth-code' });

    expect(res._getRedirectUrl()).toBe('/profile?tab=integrations&notion=error');
    expect(mockAuditFailure).toHaveBeenCalledWith('missing_state');
    expect(warnSpy).toHaveBeenCalledWith('Notion callback missing state parameter');
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('GET /api/mcp-servers/notion/callback - authorization not completed', () => {
  it('logs a declined consent at warn with only the RFC 6749 code', async () => {
    const errorSpy = mockLogger.error;
    const warnSpy = mockLogger.warn;

    const res = await call({ error: 'access_denied', state: 'opaque-state' });

    expect(res._getRedirectUrl()).toBe('/profile?tab=integrations&notion=error');
    expect(mockAuditFailure).toHaveBeenCalledWith('oauth_error');
    expect(warnSpy).toHaveBeenCalledWith('Notion authorization not completed', { error: 'access_denied' });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('never logs a free-text error param verbatim', async () => {
    const warnSpy = mockLogger.warn;

    await call({ error: 'call 555-0100' });

    expect(warnSpy).toHaveBeenCalledWith('Notion authorization not completed', { error: 'unrecognized' });
  });

  it('logs a callback with no code at all at warn', async () => {
    const errorSpy = mockLogger.error;
    const warnSpy = mockLogger.warn;

    const res = await call({});

    expect(res._getRedirectUrl()).toBe('/profile?tab=integrations&notion=error');
    expect(mockAuditFailure).toHaveBeenCalledWith('missing_code');
    expect(warnSpy).toHaveBeenCalledWith('Notion callback missing authorization code');
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

const signedState = (nonce = BROWSER_NONCE) => {
  const timestamp = Date.now();
  const nonceHash = crypto.createHash('sha256').update(nonce).digest('hex');
  const signature = crypto
    .createHmac('sha256', 'test-secret')
    .update(`user-1:csrf:${timestamp}:${nonceHash}`)
    .digest('hex');
  return JSON.stringify({ userId: 'user-1', csrfToken: 'csrf', timestamp, nonceHash, signature });
};

const AUTH_CODE_SECRETS = ['auth-code', CLIENT_SECRET, 'redirect.example', 'cb-secret'];

describe('GET /api/mcp-servers/notion/callback - token exchange failure', () => {
  it('logs only the status, never the code, response body, redirect_uri or client secret', async () => {
    mockUpdateMany.mockResolvedValue({ modifiedCount: 1 });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('provider-body-secret', { status: 400 }));

    const res = await call({ code: 'auth-code', state: signedState() });
    fetchSpy.mockRestore();

    expect(res._getRedirectUrl()).toContain('notion=error');
    expect(mockLogger.error).toHaveBeenCalledWith('Notion token exchange failed', { userId: 'user-1', status: 400 });
    expectNoSecretsLogged([...AUTH_CODE_SECRETS, 'provider-body-secret']);
  });
});

describe('GET /api/mcp-servers/notion/callback - success', () => {
  it('logs no token or code', async () => {
    mockUpdateMany.mockResolvedValue({ modifiedCount: 1 });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'access-token-xyz', workspace_id: 'w1' }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response('search-body-secret', { status: 500 }));

    const res = await call({ code: 'auth-code', state: signedState() });
    fetchSpy.mockRestore();

    expect(res._getRedirectUrl()).toContain('notion=connected');
    expect(mockLogger.info).toHaveBeenCalledWith('Notion tokens stored', { userId: 'user-1', status: 'connected' });
    expectNoSecretsLogged([...AUTH_CODE_SECRETS, 'access-token-xyz', 'search-body-secret']);
  });
});

describe('GET /api/mcp-servers/notion/callback - browser binding', () => {
  it.each([
    ['no nonce cookie', ''],
    ["another browser's nonce cookie", 'b4m_oauth_nonce_notion-connect=other-browser'],
  ])(
    'rejects a valid state completed with %s, before consuming the nonce or exchanging the code',
    async (_label, cookie) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const res = await call({ code: 'auth-code', state: signedState() }, cookie);
      fetchSpy.mockRestore();

      expect(res._getRedirectUrl()).toBe('/profile?tab=integrations&notion=error');
      expect(mockAuditFailure).toHaveBeenCalledWith('session_mismatch');
      expect(mockUpdateMany).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );

  it("rejects a state whose nonce hash was swapped for another browser's", async () => {
    const state = JSON.parse(signedState());
    state.nonceHash = crypto.createHash('sha256').update('attacker-nonce').digest('hex');

    const res = await call(
      { code: 'auth-code', state: JSON.stringify(state) },
      'b4m_oauth_nonce_notion-connect=attacker-nonce'
    );

    expect(res._getRedirectUrl()).toBe('/profile?tab=integrations&notion=error');
    expect(mockAuditFailure).toHaveBeenCalledWith('csrf_signature_invalid');
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('expires the nonce cookie alongside the result cookie', async () => {
    const res = await call({ code: 'auth-code', state: signedState() }, '');

    const cookies = res.getHeader('Set-Cookie') as string[];
    expect(cookies).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^b4m_oauth_nonce_notion-connect=; .*Max-Age=0/),
        expect.stringMatching(/^notion_error=/),
      ])
    );
  });
});
