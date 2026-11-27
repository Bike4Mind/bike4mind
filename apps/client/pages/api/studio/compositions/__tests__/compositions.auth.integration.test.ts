// @vitest-environment node
/**
 * Pins how the Studio compositions routes authenticate, through each route's real baseApi chain: passport JWT
 * verification, the jwtOnly api-key exclusion, the relying-party OAuth gate and CSRF all run for real, as does
 * studioCompositionService. Only the data edges (User lookup, secret rotation, the composition store), the rate
 * limiters and the Studio rollout gate are stubbed; the rollout gate has its own tests in server-utils.
 *
 * The caller under test is a first-party client that holds an access token and no cookie jar, the way B4M Desktop
 * calls these routes after its device-flow sign-in. Modeled on sessions/__tests__/auth-behavior.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';
import jwt from 'jsonwebtoken';
import { StudioCompositionContentSchema, defaultStudioTimeline } from '@bike4mind/common';

// ObjectId-shaped, since the chain's background activity writes cast req.user.id.
const OWNER_ID = '1'.repeat(24);
const OTHER_ID = '2'.repeat(24);

type StoredComposition = Record<string, unknown> & { id: string; userId: string };

const mocks = vi.hoisted(() => ({
  findUserById: vi.fn(),
  findRotation: vi.fn(),
  validateApiKey: vi.fn(),
  store: new Map<string, StoredComposition>(),
}));

vi.mock('@bike4mind/server-utils/auth/mfaEnforcement', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  isMfaEnrollmentOwed: async () => false,
}));
vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mocks.findUserById(...a) }),
    // desktopToken() carries a sid, and the verifier rejects a sid with no live AuthSession.
    authSessionRepository: {
      ...(actual.authSessionRepository as object),
      findBySid: async (sid: string) => ({
        sid,
        userId: sid.replace(/^sid-/, ''),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        revokedAt: null,
      }),
    },
  };
});
vi.mock('@bike4mind/database/infra', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    secretRotationRepository: {
      ...(actual.secretRotationRepository as object),
      findByKeyNameWithSecret: (...a: unknown[]) => mocks.findRotation(...a),
    },
  };
});
vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    userApiKeyService: {
      ...(actual.userApiKeyService as object),
      validateUserApiKey: (...a: unknown[]) => mocks.validateApiKey(...a),
    },
  };
});
vi.mock('@bike4mind/server-utils/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: vi.fn().mockResolvedValue({ allowed: true, headers: {} }),
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', async () =>
  (await import('@server/generations/__test__/routeHarness')).rateLimitMiddlewareMock()
);
vi.mock('@server/middlewares/perUserRateLimit', () => ({
  perUserRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/analytics/analyticsMiddleware', () => ({
  analyticsMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
// The rollout gate is open here; it still runs after auth, so it never sees an unauthenticated request.
vi.mock('@bike4mind/server-utils/middlewares/studioFeatureFlag', () => ({
  requireStudioFeature: () => (req: { user?: unknown }, _res: unknown, next: (err?: unknown) => void) =>
    next(req.user ? undefined : new Error('studio gate reached without an authenticated user')),
}));
// An owner-scoped in-memory store with the repository's contract: every *Owned call matches id AND userId.
vi.mock('@server/studio/studioCompositionAdapters', () => {
  const owned = (id: string, userId: string) => {
    const doc = mocks.store.get(id);
    return doc && doc.userId === userId ? doc : null;
  };
  return {
    studioCompositionAdapters: {
      db: {
        compositions: {
          findOwned: async (id: string, userId: string) => owned(id, userId),
          listOwned: async (userId: string) => [...mocks.store.values()].filter(doc => doc.userId === userId),
          createOwned: async (content: Record<string, unknown> & { userId: string }) => {
            const now = new Date('2026-11-01T00:00:00.000Z');
            const doc = { ...content, id: 'c'.repeat(24), createdAt: now, updatedAt: now };
            mocks.store.set(doc.id, doc);
            return doc;
          },
          updateOwned: async (id: string, userId: string, patch: Record<string, unknown>) => {
            const doc = owned(id, userId);
            if (!doc) return null;
            const next = { ...doc, ...patch };
            mocks.store.set(id, next);
            return next;
          },
          deleteOwned: async (id: string, userId: string) => (owned(id, userId) ? mocks.store.delete(id) : false),
        },
        fabFiles: { findAccessibleInIds: async () => [] },
        projects: { findByIdAndUserId: async () => null },
      },
    },
  };
});

import { Config } from '@bike4mind/server-utils/utils/config';
import { REFRESH_COOKIE_NAME } from '@bike4mind/server-utils/auth/refreshCookie';
import { authTokenGenerator } from '@server/auth/tokenGenerator';
import collectionHandler from '../index';
import itemHandler from '../[id]';

type Handler = (req: unknown, res: unknown) => Promise<void>;
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

const OWNED_ID = 'a'.repeat(24);
const createdAt = new Date('2026-10-01T00:00:00.000Z');
const ownedComposition = (): StoredComposition => ({
  ...StudioCompositionContentSchema.parse({ title: 'Spring ad', timeline: defaultStudioTimeline('ad_campaign') }),
  id: OWNED_ID,
  userId: OWNER_ID,
  createdAt,
  updatedAt: createdAt,
});

const accountFor = (id: string) => ({
  id,
  _id: id,
  isSystem: false,
  isBanned: false,
  disputePending: false,
  aupAcceptedVersion: 'grandfathered',
  tokenVersion: 0,
  tags: [],
  isAdmin: false,
  roles: [],
});

/** The access token a device-flow sign-in hands Desktop: a first-party session token (typ access, no `kind`). */
const desktopToken = (userId: string) => authTokenGenerator.signAccessToken(userId, 0, { sid: `sid-${userId}` });

/** A relying-party OAuth access token (oauth/token.ts): same secret, marked kind 'oauth' with its granted scopes. */
const oauthToken = (userId: string) => {
  if (!Config.JWT_SECRET) throw new Error('JWT_SECRET not provisioned in test env');
  return jwt.sign(
    { id: userId, tokenVersion: 0, typ: 'access', kind: 'oauth', client_id: 'third-party-app', scope: 'profile' },
    String(Config.JWT_SECRET),
    { algorithm: 'HS256', expiresIn: '10m' }
  );
};

const call = async (
  handler: unknown,
  {
    method,
    headers = {},
    body,
    id,
  }: { method: Method; headers?: Record<string, string>; body?: Record<string, unknown>; id?: string }
): Promise<{ status: number; body: unknown }> => {
  const url = id ? `/api/studio/compositions/${id}` : '/api/studio/compositions';
  const { req, res } = createMocks(
    {
      method,
      url,
      query: id ? { id } : {},
      body,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    },
    { eventEmitter: EventEmitter }
  );
  await (handler as Handler)(req, res);
  const raw = res._getData();
  return { status: res._getStatusCode(), body: raw === '' ? undefined : JSON.parse(String(raw)) };
};

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('/api/studio/compositions auth paths (real baseApi chain)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store.clear();
    mocks.store.set(OWNED_ID, ownedComposition());
    mocks.findRotation.mockResolvedValue(null);
    mocks.findUserById.mockImplementation(async (id: string) => accountFor(id));
    mocks.validateApiKey.mockResolvedValue({
      isValid: true,
      keyId: 'k1',
      userId: OWNER_ID,
      scopes: ['ai:generate', 'ai:chat'],
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
    });
  });

  describe('a Desktop-style bearer token with no cookie and no Origin', () => {
    const headers = () => bearer(desktopToken(OWNER_ID));

    it('lists and reads the caller-owned compositions', async () => {
      const list = await call(collectionHandler, { method: 'GET', headers: headers() });
      expect(list.status).toBe(200);
      expect((list.body as { data: Array<{ id: string }> }).data.map(item => item.id)).toEqual([OWNED_ID]);

      const item = await call(itemHandler, { method: 'GET', headers: headers(), id: OWNED_ID });
      expect(item.status).toBe(200);
      expect((item.body as { composition: { id: string; title: string } }).composition).toMatchObject({
        id: OWNED_ID,
        title: 'Spring ad',
      });
    });

    it('creates, updates and deletes past the CSRF origin checks', async () => {
      const created = await call(collectionHandler, {
        method: 'POST',
        headers: headers(),
        body: { title: 'Desktop cut' },
      });
      expect(created.status).toBe(201);
      const createdId = (created.body as { composition: { id: string } }).composition.id;
      expect(mocks.store.get(createdId)?.userId).toBe(OWNER_ID);

      const patched = await call(itemHandler, {
        method: 'PATCH',
        headers: headers(),
        id: OWNED_ID,
        body: { title: 'Spring ad v2' },
      });
      expect(patched.status).toBe(200);
      expect(mocks.store.get(OWNED_ID)?.title).toBe('Spring ad v2');

      const deleted = await call(itemHandler, { method: 'DELETE', headers: headers(), id: OWNED_ID });
      expect(deleted.status).toBe(204);
      expect(mocks.store.has(OWNED_ID)).toBe(false);
    });

    it('still runs the CSRF origin checks when the same token arrives with a session cookie', async () => {
      const withCookie = { ...headers(), cookie: `${REFRESH_COOKIE_NAME}=session` };
      const deleted = await call(itemHandler, { method: 'DELETE', headers: withCookie, id: OWNED_ID });
      expect(deleted.status).toBe(403);
      expect(mocks.store.has(OWNED_ID)).toBe(true);
    });
  });

  it('answers 401 with no credentials and never reaches the store', async () => {
    expect((await call(collectionHandler, { method: 'GET' })).status).toBe(401);
    expect((await call(itemHandler, { method: 'GET', id: OWNED_ID })).status).toBe(401);
    expect((await call(itemHandler, { method: 'DELETE', id: OWNED_ID })).status).toBe(401);
    expect(mocks.store.has(OWNED_ID)).toBe(true);
  });

  it.each([
    ['x-api-key header', { 'x-api-key': `b4m_live_${'0'.repeat(32)}` }],
    ['Authorization: Bearer b4m_live_ key', bearer(`b4m_live_${'0'.repeat(32)}`)],
  ])('answers 401 to an API key (%s) without validating it', async (_label, headers) => {
    expect((await call(collectionHandler, { method: 'GET', headers })).status).toBe(401);
    expect((await call(itemHandler, { method: 'DELETE', headers, id: OWNED_ID })).status).toBe(401);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
    expect(mocks.store.has(OWNED_ID)).toBe(true);
  });

  it('answers 403 insufficient_scope to a relying-party OAuth token, even for the owner', async () => {
    const headers = bearer(oauthToken(OWNER_ID));
    const list = await call(collectionHandler, { method: 'GET', headers });
    expect(list.status).toBe(403);
    expect(list.body).toMatchObject({ error: 'insufficient_scope' });

    const deleted = await call(itemHandler, { method: 'DELETE', headers, id: OWNED_ID });
    expect(deleted.status).toBe(403);
    expect(mocks.store.has(OWNED_ID)).toBe(true);
  });

  it("answers 404 to a valid bearer token for another user's composition and leaves it untouched", async () => {
    const headers = bearer(desktopToken(OTHER_ID));
    const before = mocks.store.get(OWNED_ID);

    expect((await call(itemHandler, { method: 'GET', headers, id: OWNED_ID })).status).toBe(404);
    expect(
      (await call(itemHandler, { method: 'PATCH', headers, id: OWNED_ID, body: { title: 'not yours' } })).status
    ).toBe(404);
    expect((await call(itemHandler, { method: 'DELETE', headers, id: OWNED_ID })).status).toBe(404);

    const list = await call(collectionHandler, { method: 'GET', headers });
    expect(list.status).toBe(200);
    expect((list.body as { data: unknown[] }).data).toEqual([]);
    expect(mocks.store.get(OWNED_ID)).toBe(before);
  });
});
