import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { Request, Response } from 'express';
import { ApiKeyScope, ForbiddenError } from '@bike4mind/common';

const { validateUserApiKeyMock, findUserMock, handlerReached } = vi.hoisted(() => ({
  validateUserApiKeyMock: vi.fn(),
  findUserMock: vi.fn(),
  handlerReached: vi.fn(),
}));

type Handler = (req: Request, res: Response) => unknown;

// Stands in for baseApi with only the API-key step of its auth chain, run for real.
vi.mock('@server/middlewares/baseApi', async () => {
  const { apiKeyAuth } = await import('@server/middlewares/apiKeyAuth');
  return {
    baseApi: (options: { requiredScopes?: ApiKeyScope[]; grandfatherLegacyKeys?: boolean } = {}) => {
      const handlers: Record<string, Handler> = {};
      const router = async (req: Request, res: Response) => {
        await apiKeyAuth(options.requiredScopes, undefined, { grandfatherLegacyKeys: options.grandfatherLegacyKeys })(
          req,
          res,
          () => undefined
        );
        return handlers[req.method.toLowerCase()](req, res);
      };
      Object.assign(router, { use: () => router });
      for (const method of ['get', 'post', 'patch', 'delete']) {
        Object.assign(router, {
          [method]: (fn: Handler) => {
            handlers[method] = fn;
            return router;
          },
        });
      }
      return router;
    },
  };
});
// The shipped window has no cutoff yet, so every key is legacy; simulate one to tell the two apart.
const SIMULATED_CUTOFF = new Date('2026-06-01T00:00:00Z');
vi.mock('@bike4mind/server-utils/middlewares/apiKeyScopeGate', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/server-utils/middlewares/apiKeyScopeGate')>();
  return {
    ...actual,
    isLegacyApiKey: (createdAt: Date | undefined, now?: Date) =>
      actual.isLegacyApiKey(createdAt, now, { cutoff: SIMULATED_CUTOFF, endsAt: null }),
  };
});
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return { ...actual, userApiKeyService: { validateUserApiKey: validateUserApiKeyMock } };
});
vi.mock('@bike4mind/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/database')>();
  return {
    ...actual,
    User: { findById: findUserMock },
    userRepository: { findById: (...args: unknown[]) => findUserMock(...args) },
  };
});
// Every route's handler opens with this guard, so a call to it means the scope gate let the request through.
vi.mock('@server/auth/assertNotOrgServiceAccount', () => ({ assertNotOrgServiceAccount: handlerReached }));
vi.mock('@bike4mind/server-utils/utils/apiKeyTrust', () => ({
  resolveUntrustedKeyLimits: async (_owner: unknown, key: { rateLimit: unknown }) => ({
    rateLimit: key.rateLimit,
    ownerUntrusted: false,
  }),
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
  logEventSafe: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/managers/apiKeyUsageManager', () => ({
  ApiKeyUsageManager: { logUsage: vi.fn().mockResolvedValue(undefined) },
}));

import listOrCreate from '../index';
import keyById from '../[id]/index';
import revoke from '../[id]/revoke';
import rotate from '../[id]/rotate';
import rateLimit from '../[id]/rate-limit';
import billingOrganizations from '../billing-organizations';

const loggerInfo = vi.fn();
const KEY = 'b4m_live_0123456789abcdef0123456789abcdef';
const LEGACY_CREATED_AT = new Date('2026-01-01T00:00:00Z');
const POST_CUTOFF_CREATED_AT = new Date('2026-09-01T00:00:00Z');

// The legacy-pass log is deduped per key id, so each key needs its own id.
let keySeq = 0;
function keyWith(scopes: ApiKeyScope[], createdAt: Date = POST_CUTOFF_CREATED_AT) {
  keySeq += 1;
  validateUserApiKeyMock.mockResolvedValue({
    isValid: true,
    keyId: `key-${keySeq}`,
    userId: 'user-1',
    scopes,
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
    createdAt,
  });
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

// The handler body past the guard is not under test, so whatever it does after is ignored.
async function call(handler: unknown, method: Method) {
  const { req, res } = createMocks({
    method,
    url: '/api/user-api-keys',
    query: { id: 'key-target' },
    body: {},
    headers: { 'x-api-key': KEY },
  });
  Object.assign(req, { logger: { info: loggerInfo, warn: vi.fn(), error: vi.fn() } });
  await (handler as Handler)(req as unknown as Request, res as unknown as Response);
}

const reachesHandler = async (handler: unknown, method: Method) => {
  handlerReached.mockImplementation(() => {
    throw new Error('handler reached');
  });
  await expect(call(handler, method)).rejects.toThrow('handler reached');
  expect(handlerReached).toHaveBeenCalledTimes(1);
};

const isRefused = async (handler: unknown, method: Method) => {
  await expect(call(handler, method)).rejects.toBeInstanceOf(ForbiddenError);
  expect(handlerReached).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.API_KEY_SCOPE_STAGING;
  findUserMock.mockImplementation(async () => ({ id: 'user-1', isBanned: false, isAdmin: false }));
});

describe.each([
  { name: 'GET /api/user-api-keys', handler: () => listOrCreate, method: 'GET' as const },
  { name: 'POST /api/user-api-keys', handler: () => listOrCreate, method: 'POST' as const },
  { name: 'PATCH /api/user-api-keys/[id]', handler: () => keyById, method: 'PATCH' as const },
  { name: 'DELETE /api/user-api-keys/[id]', handler: () => keyById, method: 'DELETE' as const },
  { name: 'POST /api/user-api-keys/[id]/revoke', handler: () => revoke, method: 'POST' as const },
  { name: 'POST /api/user-api-keys/[id]/rotate', handler: () => rotate, method: 'POST' as const },
  { name: 'PATCH /api/user-api-keys/[id]/rate-limit', handler: () => rateLimit, method: 'PATCH' as const },
  {
    name: 'GET /api/user-api-keys/billing-organizations',
    handler: () => billingOrganizations,
    method: 'GET' as const,
  },
])('$name', ({ handler, method }) => {
  it('serves a key holding api-keys:manage', async () => {
    keyWith([ApiKeyScope.API_KEYS_MANAGE]);
    await reachesHandler(handler(), method);
  });

  it('serves a key holding admin:*', async () => {
    keyWith([ApiKeyScope.ADMIN]);
    await reachesHandler(handler(), method);
  });

  it('admits a legacy key without api-keys:manage and logs the pass', async () => {
    keyWith([ApiKeyScope.READ_FILES], LEGACY_CREATED_AT);
    await reachesHandler(handler(), method);
    expect(loggerInfo).toHaveBeenCalledWith(
      'API key scope check missed but legacy key grandfathered - allowing',
      expect.objectContaining({
        keyId: `key-${keySeq}`,
        requiredScopes: [ApiKeyScope.API_KEYS_MANAGE, ApiKeyScope.ADMIN],
      })
    );
  });

  it('refuses a key created after the cutoff without api-keys:manage', async () => {
    keyWith([ApiKeyScope.READ_FILES, ApiKeyScope.AI_GENERATE]);
    await isRefused(handler(), method);
  });

  it('refuses a confined key even when it is legacy', async () => {
    keyWith([ApiKeyScope.EMBED_CHAT], LEGACY_CREATED_AT);
    await isRefused(handler(), method);
  });
});
