import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { Request, Response } from 'express';
import { ApiKeyScope, ForbiddenError } from '@bike4mind/common';

const { validateUserApiKeyMock, findUserMock, searchAccessibleMock, findSkillMock } = vi.hoisted(() => ({
  validateUserApiKeyMock: vi.fn(),
  findUserMock: vi.fn(),
  searchAccessibleMock: vi.fn(),
  findSkillMock: vi.fn(),
}));

type Handler = (req: Request, res: Response) => unknown;

// Stands in for baseApi with only the API-key step of its auth chain, run for real.
vi.mock('@client/server/middlewares/baseApi', async () => {
  const { apiKeyAuth } = await import('@server/middlewares/apiKeyAuth');
  return {
    baseApi: (options: { requiredScopes?: ApiKeyScope[] } = {}) => {
      const handlers: Record<string, Handler> = {};
      const router = async (req: Request, res: Response) => {
        await apiKeyAuth(options.requiredScopes)(req, res, () => undefined);
        return handlers[req.method.toLowerCase()](req, res);
      };
      for (const method of ['get', 'post', 'put', 'delete']) {
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
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return { ...actual, userApiKeyService: { validateUserApiKey: validateUserApiKeyMock } };
});
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: {} }));
vi.mock('@bike4mind/database', () => ({
  User: { findById: findUserMock },
  userRepository: { findById: (...args: unknown[]) => findUserMock(...args) },
  skillRepository: { searchAccessible: searchAccessibleMock, findById: findSkillMock },
  adminSettingsRepository: {},
  scopedSettingsRepository: {},
  organizationRepository: {},
}));
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findIdsAdministeredBy: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@server/skillMarket/marketStatus', () => ({ attachMarketStatus: async (rows: unknown[]) => rows }));
vi.mock('@bike4mind/server-utils/auth/ability', () => ({ default: () => ({ can: () => true }) }));
vi.mock('@bike4mind/server-utils/utils/apiKeyTrust', () => ({
  resolveUntrustedKeyLimits: async (_owner: unknown, key: { rateLimit: unknown }) => ({
    rateLimit: key.rateLimit,
    ownerUntrusted: false,
  }),
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@bike4mind/server-utils/managers/apiKeyUsageManager', () => ({
  ApiKeyUsageManager: { logUsage: vi.fn().mockResolvedValue(undefined) },
}));

import listSkills from '../index';
import skillById from '../[id]/index';
import shareSkill from '../[id]/share';

const KEY = 'b4m_live_0123456789abcdef0123456789abcdef';

function keyWith(scopes: ApiKeyScope[]) {
  validateUserApiKeyMock.mockResolvedValue({
    isValid: true,
    keyId: 'key-1',
    userId: 'user-1',
    scopes,
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
  });
}

async function call(handler: unknown, method: 'GET' | 'PUT' | 'DELETE', auth: 'key' | 'session') {
  const { req, res } = createMocks({
    method,
    url: '/api/skills',
    query: { id: 'skill-1' },
    body: {},
    headers: auth === 'key' ? { 'x-api-key': KEY } : {},
  });
  Object.assign(req, { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  if (auth === 'session') Object.assign(req, { user: { id: 'user-1', isAdmin: false } });
  await (handler as Handler)(req as unknown as Request, res as unknown as Response);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.API_KEY_SCOPE_STAGING;
  findUserMock.mockImplementation(async () => ({ id: 'user-1', isBanned: false, isAdmin: false }));
  searchAccessibleMock.mockResolvedValue({ data: [], total: 0, hasMore: false });
});

describe.each([
  { name: 'GET /api/skills', handler: () => listSkills, method: 'GET' as const },
  { name: 'GET /api/skills/[id]', handler: () => skillById, method: 'GET' as const },
  { name: 'DELETE /api/skills/[id]', handler: () => skillById, method: 'DELETE' as const },
  { name: 'PUT /api/skills/[id]/share', handler: () => shareSkill, method: 'PUT' as const },
])('$name', ({ handler, method }) => {
  it('refuses an API key without skills:write before the handler runs', async () => {
    keyWith([ApiKeyScope.READ_FILES, ApiKeyScope.WRITE_FILES]);
    await expect(call(handler(), method, 'key')).rejects.toBeInstanceOf(ForbiddenError);
    expect(searchAccessibleMock).not.toHaveBeenCalled();
    expect(findSkillMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/skills', () => {
  it('serves an API key holding skills:write', async () => {
    keyWith([ApiKeyScope.SKILLS_WRITE]);
    expect((await call(listSkills, 'GET', 'key'))._getStatusCode()).toBe(200);
    expect(searchAccessibleMock).toHaveBeenCalled();
  });

  it('serves a browser session without consulting the key gate', async () => {
    expect((await call(listSkills, 'GET', 'session'))._getStatusCode()).toBe(200);
    expect(validateUserApiKeyMock).not.toHaveBeenCalled();
  });
});
