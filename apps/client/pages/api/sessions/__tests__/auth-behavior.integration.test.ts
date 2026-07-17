// @vitest-environment node
/**
 * REPRODUCTION / decision-gate test for issue #626.
 *
 * Issue #626 claims GET /api/sessions is an *optional-auth* endpoint that returns
 * `200 []` when the bearer access token is expired/invalid (masking the auth
 * failure so the client's 401 refresh-and-retry interceptor never fires). This
 * test drives the REAL next-connect chain `baseApi()` assembles - passport JWT
 * strategy, secret-rotation fallback, tokenVersion kill-switch, consent gate -
 * with genuinely signed / expired / garbage bearer tokens to record what status
 * code each actually produces. Only the data edges are stubbed (connectDB, the
 * User lookup, the secret-rotation repo, the session service, analytics).
 *
 * Modeled on overwatch events.integration.test.ts (same real-chain approach).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';
import jwt from 'jsonwebtoken';

const USER_ID = 'user-626';

const { mockFindById, mockFindRotation, mockSearchOwnSessions, mockCountOwnSessions } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockFindRotation: vi.fn(),
  mockSearchOwnSessions: vi.fn(),
  mockCountOwnSessions: vi.fn(),
}));

// connectDB must not hit Mongo; User.findById feeds the JWT verify callback.
vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockFindById(...a) }),
  };
});

// The secret-rotation lookup runs in the JWT secretOrKeyProvider catch path
// (expired/garbage token). Stub it so it resolves instead of buffering forever
// against the stubbed connectDB. null => no previous key => no grace-period retry.
vi.mock('@bike4mind/database/infra', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    secretRotationRepository: {
      ...(actual.secretRotationRepository as object),
      findByKeyName: (...a: unknown[]) => mockFindRotation(...a),
    },
  };
});

// Only the session read is stubbed; the auth chain above it all runs for real.
vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    sessionService: {
      ...(actual.sessionService as object),
      searchOwnSessions: (...a: unknown[]) => mockSearchOwnSessions(...a),
      countOwnSessions: (...a: unknown[]) => mockCountOwnSessions(...a),
    },
  };
});

// Fire-and-forget writes: keep them off the DB / out of the output.
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/analytics/analyticsMiddleware', () => ({
  analyticsMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import handler from '../index';
import favoritesHandler from '../favorites';
import sharedHandler from '../shared';
import countHandler from '../count';
import recentProactiveHandler from '../recent-proactive-messages';
import semanticSearchHandler from '../semantic-search';
import { Config } from '@server/utils/config';

type ApiHandler = (req: unknown, res: unknown) => Promise<void> | void;

// authTokenGenerator (tokenGenerator.ts) captures Config.JWT_SECRET at import time,
// so a valid token must be signed with the SAME secret the running chain verifies
// against - read it here rather than overriding Config after the fact. Fail loudly
// if the secret isn't provisioned, otherwise the VALID-token cases fail confusingly.
if (!Config.JWT_SECRET) throw new Error('JWT_SECRET not provisioned in test env');
const REAL_SECRET = String(Config.JWT_SECRET);

function sign(payload: object, opts: jwt.SignOptions, secret = REAL_SECRET) {
  return jwt.sign(payload, secret, { algorithm: 'HS256', ...opts });
}

function fire(token: string | null, method: 'GET' | 'POST' = 'GET', url = '/api/sessions') {
  const { req, res } = createMocks(
    {
      method,
      url,
      query: {},
      body: method === 'POST' ? { query: 'x' } : undefined,
      headers: {
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    },
    { eventEmitter: EventEmitter }
  );
  // any: node-mocks-http req/res aren't structurally the Express types the chain is typed for.
  return { req: req as any, res: res as any };
}

const expiredToken = () => sign({ id: USER_ID, tokenVersion: 0 }, { expiresIn: '-1h' });

describe('GET /api/sessions auth behavior (issue #626 decision gate)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindRotation.mockResolvedValue(null);
    mockSearchOwnSessions.mockResolvedValue([]);
    // A consented, non-system, current-version account so a VALID token reaches the handler.
    mockFindById.mockReturnValue(
      Promise.resolve({
        id: USER_ID,
        _id: USER_ID,
        isSystem: false,
        isBanned: false,
        disputePending: false,
        aupAcceptedVersion: 'grandfathered',
        tokenVersion: 0,
        tags: [],
        isAdmin: false,
        roles: [],
      })
    );
  });

  it('VALID token -> 200 [] (authenticated, zero sessions is the real empty case)', async () => {
    const token = sign({ id: USER_ID, tokenVersion: 0 }, { expiresIn: '7d' });
    const { req, res } = fire(token);
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual([]);
    expect(mockSearchOwnSessions).toHaveBeenCalledTimes(1);
  });

  it('EXPIRED token -> 401 (must not mask as 200 []); handler never runs', async () => {
    const token = sign({ id: USER_ID, tokenVersion: 0 }, { expiresIn: '-1h' });
    const { req, res } = fire(token);
    await handler(req, res);
    expect(res._getStatusCode()).toBe(401);
    expect(mockSearchOwnSessions).not.toHaveBeenCalled();
  });

  it('GARBAGE token -> 401; handler never runs', async () => {
    const { req, res } = fire('garbage.token.value');
    await handler(req, res);
    expect(res._getStatusCode()).toBe(401);
    expect(mockSearchOwnSessions).not.toHaveBeenCalled();
  });

  it('WRONG-SECRET token -> 401; handler never runs', async () => {
    const token = sign({ id: USER_ID, tokenVersion: 0 }, { expiresIn: '7d' }, 'a-different-secret');
    const { req, res } = fire(token);
    await handler(req, res);
    expect(res._getStatusCode()).toBe(401);
    expect(mockSearchOwnSessions).not.toHaveBeenCalled();
  });

  it('NO token -> 401; handler never runs', async () => {
    const { req, res } = fire(null);
    await handler(req, res);
    expect(res._getStatusCode()).toBe(401);
    expect(mockSearchOwnSessions).not.toHaveBeenCalled();
  });

  it('VALID token -> count 200 { count } (non-list shape still reaches handler)', async () => {
    mockCountOwnSessions.mockResolvedValue({ count: 0 });
    const token = sign({ id: USER_ID, tokenVersion: 0 }, { expiresIn: '7d' });
    const { req, res } = fire(token, 'GET', '/api/sessions/count');
    await countHandler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ count: 0 });
  });
});

// The whole audit list from issue #626. Each mounts via baseApi() (auth:true), so an
// expired or absent bearer token must 401 at the shared auth middleware BEFORE the
// handler's own `req.user ? ... : []` / `{count:0}` / `{}` fallback could ever mask it.
describe('issue #626 audit list: no session endpoint masks an invalid token as success', () => {
  const endpoints: Array<{ name: string; handler: ApiHandler; method: 'GET' | 'POST'; url: string }> = [
    { name: 'GET /api/sessions', handler: handler as ApiHandler, method: 'GET', url: '/api/sessions' },
    {
      name: 'GET /api/sessions/favorites',
      handler: favoritesHandler as ApiHandler,
      method: 'GET',
      url: '/api/sessions/favorites',
    },
    {
      name: 'GET /api/sessions/shared',
      handler: sharedHandler as ApiHandler,
      method: 'GET',
      url: '/api/sessions/shared',
    },
    { name: 'GET /api/sessions/count', handler: countHandler as ApiHandler, method: 'GET', url: '/api/sessions/count' },
    {
      name: 'GET /api/sessions/recent-proactive-messages',
      handler: recentProactiveHandler as ApiHandler,
      method: 'GET',
      url: '/api/sessions/recent-proactive-messages',
    },
    {
      name: 'POST /api/sessions/semantic-search',
      handler: semanticSearchHandler as ApiHandler,
      method: 'POST',
      url: '/api/sessions/semantic-search',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindRotation.mockResolvedValue(null);
  });

  for (const ep of endpoints) {
    it(`${ep.name}: EXPIRED token -> 401 (not a masked 200/empty)`, async () => {
      const { req, res } = fire(expiredToken(), ep.method, ep.url);
      await ep.handler(req, res);
      expect(res._getStatusCode()).toBe(401);
    });

    it(`${ep.name}: NO token -> 401`, async () => {
      const { req, res } = fire(null, ep.method, ep.url);
      await ep.handler(req, res);
      expect(res._getStatusCode()).toBe(401);
    });
  }
});
