import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { Request, Response } from 'express';
import { ApiKeyScope, ForbiddenError } from '@bike4mind/common';

const { validateUserApiKeyMock, findUserMock, listBlockedMock, revokeSessionsMock, inboxDeleteMock } = vi.hoisted(
  () => ({
    inboxDeleteMock: vi.fn(),
    validateUserApiKeyMock: vi.fn(),
    findUserMock: vi.fn(),
    listBlockedMock: vi.fn(),
    revokeSessionsMock: vi.fn(),
  })
);

type Handler = (req: Request, res: Response) => unknown;

// Stands in for baseApi with only the API-key step of its auth chain, run for real.
vi.mock('@server/middlewares/baseApi', async () => {
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
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: Handler) => fn }));
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return {
    ...actual,
    userApiKeyService: { validateUserApiKey: validateUserApiKeyMock },
    userService: { ...actual.userService, adminRevokeUserSessions: revokeSessionsMock },
  };
});
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: {} }));
vi.mock('@bike4mind/database', () => ({
  User: { findById: findUserMock },
  blockedIPRepository: { list: listBlockedMock },
  userRepository: { findById: vi.fn().mockResolvedValue(null) },
  authSessionRepository: {},
  trustedDeviceRepository: { revokeAllForUser: vi.fn().mockResolvedValue(0) },
  realtimeConnectionRepository: {},
  passkeyCredentialRepository: {},
  inboxRepository: {
    findById: vi.fn().mockResolvedValue({ id: 'inbox-1', receiverId: 'someone-else' }),
    deleteByReceiverId: inboxDeleteMock,
  },
  withTransaction: vi.fn(),
}));
vi.mock('@server/auth/ability', () => ({ default: () => ({}) }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@bike4mind/server-utils/managers/apiKeyUsageManager', () => ({
  ApiKeyUsageManager: { logUsage: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@server/websocket/utils', () => ({ sendToClient: vi.fn().mockResolvedValue(undefined) }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'wss://test' } } }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/utils/adminAudit', () => ({
  recordAdminActionFromRequest: vi.fn().mockResolvedValue(null),
  denySelfAdminAction: vi.fn(),
  isSelfOrImpersonator: vi.fn(),
  parseAdminActionReason: vi.fn(),
}));

import blockedIps from '../security/blocked-ips';
import revokeSessions from '../users/[id]/revoke-sessions';
import forceMfaReset from '../auth/mfa/force-reset';
import deleteInboxItem from '../inbox/[id]/delete';

const KEY = 'b4m_live_0123456789abcdef0123456789abcdef';

function keyWith(scopes: ApiKeyScope[]) {
  validateUserApiKeyMock.mockResolvedValue({
    isValid: true,
    keyId: 'key-1',
    userId: 'admin-1',
    scopes,
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
  });
}

async function call(handler: unknown, method: 'GET' | 'POST' | 'DELETE', auth: 'key' | 'session') {
  const { req, res } = createMocks({
    method,
    url: '/api/test',
    query: { id: 'target-1' },
    headers: auth === 'key' ? { 'x-api-key': KEY } : {},
  });
  Object.assign(req, { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  if (auth === 'session') Object.assign(req, { user: { id: 'admin-1', isAdmin: true } });
  await (handler as Handler)(req as unknown as Request, res as unknown as Response);
  return res;
}

const routes = [
  { name: 'security/blocked-ips', handler: () => blockedIps, method: 'GET' as const },
  { name: 'users/[id]/revoke-sessions', handler: () => revokeSessions, method: 'POST' as const },
];

beforeEach(() => {
  vi.clearAllMocks();
  findUserMock.mockResolvedValue({ id: 'admin-1', isBanned: false, isAdmin: true });
  listBlockedMock.mockResolvedValue([]);
  revokeSessionsMock.mockResolvedValue(2);
});

describe.each(routes)('$name with an admin-owned caller', ({ handler, method }) => {
  it('refuses an API key without the admin scope', async () => {
    keyWith([ApiKeyScope.AI_CHAT]);
    await expect(call(handler(), method, 'key')).rejects.toBeInstanceOf(ForbiddenError);
    expect(listBlockedMock).not.toHaveBeenCalled();
    expect(revokeSessionsMock).not.toHaveBeenCalled();
  });

  it('serves an API key holding the admin scope', async () => {
    keyWith([ApiKeyScope.ADMIN]);
    expect((await call(handler(), method, 'key'))._getStatusCode()).toBe(200);
  });

  it('serves a signed-in admin session', async () => {
    expect((await call(handler(), method, 'session'))._getStatusCode()).toBe(200);
    expect(validateUserApiKeyMock).not.toHaveBeenCalled();
  });
});

describe('auth/mfa/force-reset with an admin-owned caller', () => {
  it('refuses an API key without the admin scope', async () => {
    keyWith([ApiKeyScope.AI_CHAT]);
    expect((await call(forceMfaReset, 'POST', 'key'))._getStatusCode()).toBe(403);
  });
});

describe('inbox/[id]/delete on an item addressed to another user', () => {
  it('refuses an admin-owned key without the admin scope', async () => {
    keyWith([ApiKeyScope.AI_CHAT]);
    await expect(call(deleteInboxItem, 'DELETE', 'key')).rejects.toThrow(/Inbox not found/);
    expect(inboxDeleteMock).not.toHaveBeenCalled();
  });

  it('serves an admin-scoped key', async () => {
    keyWith([ApiKeyScope.ADMIN]);
    expect((await call(deleteInboxItem, 'DELETE', 'key'))._getStatusCode()).toBe(200);
    expect(inboxDeleteMock).toHaveBeenCalledWith('someone-else', 'target-1');
  });
});
