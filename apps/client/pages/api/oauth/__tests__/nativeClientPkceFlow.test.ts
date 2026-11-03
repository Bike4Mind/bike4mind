import { createHash, randomUUID } from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * First-party native client over the real OAuth PKCE flow: authorize (code) -> token -> refresh ->
 * active-sessions listing. Only the persistence seam is faked (in-memory repositories); the
 * oauthServer helpers, the route handlers, issueSession and rotateSession are all real.
 */

type SessionRow = Record<string, unknown> & { sid: string; userId: string; refreshTokenHash: string };
type CodeRow = {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  userId: string;
  used: boolean;
  expiresAt: Date;
};

const store = vi.hoisted(() => ({
  clients: new Map<string, Record<string, unknown>>(),
  codes: new Map<string, unknown>(),
  sessions: new Map<string, unknown>(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {
      use: () => chain,
      post: (fn: unknown) => fn,
      get: (fn: unknown) => {
        chain.getFn = fn;
        return chain;
      },
      delete: () => chain,
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/checkBlockedIP', () => ({ checkBlockedIP: vi.fn() }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: vi.fn() }));
vi.mock('@server/middlewares/apiKeyAuth', () => ({ isApiKeyAuth: () => false }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn() }));
vi.mock('@server/auth/networkMeta', () => ({ recordLoginEvent: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: {} }));
vi.mock('@server/auth/tokenGenerator', () => ({
  ACCESS_TOKEN_TTL_SECONDS: 3600,
  authTokenGenerator: {
    signAccessToken: (id: string, _tv: number, extra?: { sid?: string }) => `at:${id}:${extra?.sid}`,
  },
}));
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  redactUserSecretsForSelf: (user: unknown) => user,
}));

vi.mock('@bike4mind/database', () => {
  const sessions = store.sessions as Map<string, SessionRow>;
  const codes = store.codes as Map<string, CodeRow>;
  return {
    oauthClientRepository: { findByClientId: async (id: string) => store.clients.get(id) ?? null },
    oauthAuthorizationCodeRepository: {
      create: async (row: CodeRow) => void codes.set(row.code, row),
      findValidCode: async (code: string) => {
        const row = codes.get(code);
        return row && !row.used && row.expiresAt > new Date() ? row : null;
      },
      consumeValidCode: async (code: string) => {
        const row = codes.get(code);
        if (!row || row.used) return null;
        row.used = true;
        return row;
      },
    },
    oauthGrantRepository: {},
    oauthRefreshTokenRepository: {},
    cacheRepository: {},
    userRepository: {
      findById: async (id: string) => ({ id, email: 'u@example.com', username: 'u', tokenVersion: 0 }),
    },
    User: {},
    realtimeConnectionRepository: {},
    authSessionRepository: {
      create: async (row: Omit<SessionRow, 'id'>) => {
        const created = { ...row, createdAt: new Date(), updatedAt: new Date() } as SessionRow;
        sessions.set(created.sid, created);
        return created;
      },
      findBySid: async (sid: string) => sessions.get(sid) ?? null,
      findActiveByUserId: async (userId: string) => [...sessions.values()].filter(s => s.userId === userId),
      rotateHash: async (
        sid: string,
        p: { expectedCurrentHash: string; nextHash: string; replayExpiresAt: Date; newExpiresAt: Date }
      ) => {
        const row = sessions.get(sid);
        if (!row || row.refreshTokenHash !== p.expectedCurrentHash) return null;
        Object.assign(row, {
          previousRefreshTokenHash: row.refreshTokenHash,
          refreshTokenHash: p.nextHash,
          graceExpiresAt: p.replayExpiresAt,
          expiresAt: p.newExpiresAt,
          lastUsedAt: new Date(),
        });
        return row;
      },
    },
  };
});
vi.mock('@bike4mind/database/infra', () => ({ secretRotationRepository: {} }));

import codeHandler from '../code';
import tokenHandler from '../token';
import refreshHandler from '../../auth/refreshToken';
import sessionsHandler from '../../users/me/sessions';

const CLIENT_ID = 'b4m-ios-app';
const REDIRECT_URI = 'https://app.bike4mind.com/ios/auth-callback';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

async function invoke(handler: unknown, options: { method?: 'GET' | 'POST'; body?: unknown; user?: unknown }) {
  const { req, res } = createMocks({ method: options.method ?? 'POST', body: options.body as object });
  // any: node-mocks-http mocks are not structurally the Express types.
  (req as any).logger = { log: vi.fn(), warn: vi.fn(), info: vi.fn() };
  (req as any).user = options.user;
  (req as any).headers['user-agent'] = 'B4MNative/1.0';
  await (handler as Handler)(req, res);
  return { status: res._getStatusCode(), json: res._getJSONData() as Record<string, any> };
}

const authorize = async () => {
  const { status, json } = await invoke(codeHandler, {
    body: {
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    },
    user: { id: 'user-1' },
  });
  expect(status).toBe(200);
  return json.code as string;
};

const exchange = async (extra: Record<string, unknown> = {}) => {
  const code = await authorize();
  return invoke(tokenHandler, {
    body: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: VERIFIER,
      ...extra,
    },
  });
};

const onlySession = () => [...store.sessions.values()][0] as Record<string, any>;

describe('native client OAuth PKCE flow', () => {
  beforeEach(() => {
    process.env.APP_URL = 'https://app.bike4mind.com';
    store.codes.clear();
    store.sessions.clear();
    store.clients.set(CLIENT_ID, {
      clientId: CLIENT_ID,
      redirectUris: [REDIRECT_URI],
      allowedScopes: ['openid', 'email', 'profile'],
      tokenEndpointAuthMethod: 'none',
      clientType: 'first-party',
      isActive: true,
    });
  });

  it('accepts the https universal-link redirect and mints an ios-labelled session with the device name', async () => {
    const { status, json } = await exchange({ deviceName: 'Primary Phone' });

    expect(status).toBe(200);
    expect(json.refresh_token).toEqual(expect.any(String));
    expect(json.access_token).toEqual(expect.any(String));
    expect(onlySession()).toMatchObject({
      userId: 'user-1',
      createdVia: 'ios',
      clientId: CLIENT_ID,
      device: { displayName: 'Primary Phone', userAgent: 'B4MNative/1.0' },
    });
  });

  it('rejects a redirect URI that is not an exact match of the registered universal link', async () => {
    const { status } = await invoke(codeHandler, {
      body: {
        client_id: CLIENT_ID,
        redirect_uri: `${REDIRECT_URI}/extra`,
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
      },
      user: { id: 'user-1' },
    });
    expect(status).toBe(400);
  });

  it('trims the device name and caps it at 64 characters', async () => {
    await exchange({ deviceName: `   ${'x'.repeat(100)}   ` });
    expect(onlySession().device.displayName).toBe('x'.repeat(64));
  });

  it('omits displayName when no device name is sent, and ignores a blank one', async () => {
    await exchange({ deviceName: '   ' });
    expect(onlySession().device.displayName).toBeUndefined();
  });

  it('keeps the generic oauth-token label for other first-party clients', async () => {
    store.clients.set('other-first-party', {
      ...store.clients.get(CLIENT_ID),
      clientId: 'other-first-party',
    });
    const code = await invoke(codeHandler, {
      body: {
        client_id: 'other-first-party',
        redirect_uri: REDIRECT_URI,
        code_challenge: CHALLENGE,
        code_challenge_method: 'S256',
      },
      user: { id: 'user-1' },
    });
    await invoke(tokenHandler, {
      body: {
        grant_type: 'authorization_code',
        code: code.json.code,
        redirect_uri: REDIRECT_URI,
        client_id: 'other-first-party',
        code_verifier: VERIFIER,
      },
    });
    expect(onlySession().createdVia).toBe('oauth-token');
  });

  it('rejects a wrong code_verifier', async () => {
    const code = await authorize();
    const { status, json } = await invoke(tokenHandler, {
      body: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: 'A'.repeat(43),
      },
    });
    expect(status).toBe(400);
    expect(json.error).toBe('invalid_grant');
    expect(store.sessions.size).toBe(0);
  });

  it('POST /api/auth/refreshToken still rotates via body transport and returns the new refresh token in the body', async () => {
    const { json: issued } = await exchange({ deviceName: 'Primary Phone' });

    const first = await invoke(refreshHandler, { body: { refresh_token: issued.refresh_token } });
    expect(first.status).toBe(200);
    expect(first.json.accessToken).toEqual(expect.any(String));
    expect(first.json.refreshToken).toEqual(expect.any(String));
    expect(first.json.refreshToken).not.toBe(issued.refresh_token);

    const second = await invoke(refreshHandler, { body: { refresh_token: first.json.refreshToken } });
    expect(second.status).toBe(200);
    expect(second.json.refreshToken).not.toBe(first.json.refreshToken);
    expect(onlySession().device.displayName).toBe('Primary Phone');
  });

  it('GET /api/users/me/sessions lists the device display name', async () => {
    await exchange({ deviceName: 'Primary Phone' });
    const sid = onlySession().sid as string;

    const { status, json } = await invoke((sessionsHandler as unknown as { getFn: unknown }).getFn, {
      method: 'GET',
      user: { id: 'user-1', sid: randomUUID() },
    });

    expect(status).toBe(200);
    expect(json.items).toEqual([
      expect.objectContaining({
        sid,
        createdVia: 'ios',
        device: expect.objectContaining({ displayName: 'Primary Phone' }),
      }),
    ]);
  });
});
