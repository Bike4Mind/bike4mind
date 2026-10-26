import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * POST /api/user-api-keys/[id]/rotate and .../revoke: the routes are thin - they
 * forward to the service with the userApiKeys + organizations adapters. These
 * assert the org adapter is threaded (so the service's org-admin resolution has
 * its dependency) and that a service NotFoundError propagates. The service's own
 * minter-vs-org-admin authorization is covered in its unit tests.
 */

const mockRefs = vi.hoisted(() => ({
  rotateHandler: null as null | ((req: any, res: any) => unknown),
  revokeHandler: null as null | ((req: any, res: any) => unknown),
}));

// A fresh chain per import so rotate and revoke capture their own handler.
const isApiKeyAccessAllowedMock = vi.hoisted(() =>
  vi.fn(async (_user: unknown, _billing?: unknown, _request?: unknown) => true)
);
vi.mock('@server/utils/apiKeyAccessGate', async () => {
  const { ForbiddenError } = await import('@bike4mind/server-utils/utils/errors');
  const message = 'API keys require an active paid subscription';
  return {
    API_KEY_ACCESS_DENIED_MESSAGE: message,
    isApiKeyAccessAllowed: isApiKeyAccessAllowedMock,
    assertApiKeyAccessAllowed: async (user: unknown, billing?: unknown, request?: unknown) => {
      if (!(await isApiKeyAccessAllowedMock(user, billing, request))) throw new ForbiddenError(message);
    },
  };
});
vi.mock('@server/middlewares/baseApi', () => {
  const makeChain = (slot: 'rotateHandler' | 'revokeHandler') => {
    const chain: any = {
      get: () => chain,
      patch: () => chain,
      post: (fn: any) => {
        mockRefs[slot] = fn;
        return chain;
      },
    };
    return chain;
  };
  let calls = 0;
  return { baseApi: () => makeChain(calls++ === 0 ? 'rotateHandler' : 'revokeHandler') };
});

const rotateUserApiKey = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ id: 'key-1', name: 'k', keyPrefix: 'b4m_live_x', key: 'b4m_live_secret' })
);
const revokeUserApiKey = vi.hoisted(() => vi.fn().mockResolvedValue({ name: 'k' }));
const resolveOwnedApiKey = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'key-1' }));
vi.mock('@bike4mind/services', () => ({
  userApiKeyService: { rotateUserApiKey, revokeUserApiKey, resolveOwnedApiKey },
}));

const notifyApiKeyRotationReown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/utils/apiKeyRotationNotifier', () => ({ notifyApiKeyRotationReown }));

const userApiKeyRepository = vi.hoisted(() => ({}));
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository }));
const organizationRepository = vi.hoisted(() => ({ findIdsAdministeredBy: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  organizationRepository,
  realtimeConnectionRepository: { endConnections: vi.fn().mockResolvedValue({ connectionIds: [] }) },
}));
const logEventSafe = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/utils/analyticsLog', () => ({ logEventSafe }));

import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { realtimeConnectionRepository } from '@bike4mind/database';
// Order matters: the first baseApi() call is rotate, the second is revoke.
import '@pages/api/user-api-keys/[id]/rotate';
import '@pages/api/user-api-keys/[id]/revoke';

function post(id: string | undefined, body: unknown = {}) {
  const { req, res } = createMocks({ method: 'POST', query: id === undefined ? {} : { id }, body });
  (req as any).user = { id: 'admin-user', isAdmin: false };
  (req as any).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { req, res };
}

describe('POST /api/user-api-keys/[id]/rotate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('threads the organizations adapter into rotateUserApiKey and returns 200', async () => {
    const { req, res } = post('key-1');
    await mockRefs.rotateHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(rotateUserApiKey).toHaveBeenCalledWith(
      'admin-user',
      { keyId: 'key-1' },
      expect.objectContaining({
        db: expect.objectContaining({ organizations: organizationRepository }),
      })
    );
  });

  it('wires the realtime connection repository so a rotation ends the key sockets', async () => {
    const { req, res } = post('key-1');
    await mockRefs.rotateHandler!(req, res);
    expect(rotateUserApiKey).toHaveBeenCalledWith('admin-user', { keyId: 'key-1' }, expect.anything());
    const [, , adapters] = rotateUserApiKey.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { db: { realtimeConnections: unknown } },
    ];
    expect(adapters.db.realtimeConnections).toBe(realtimeConnectionRepository);
  });

  it('propagates a service NotFoundError', async () => {
    rotateUserApiKey.mockRejectedValueOnce(new NotFoundError('API key not found'));
    const { req, res } = post('key-1');
    await expect(mockRefs.rotateHandler!(req, res)).rejects.toThrow(/not found/i);
  });

  it('passes undefined callerScopes for a browser/JWT caller (no apiKeyInfo)', async () => {
    const { req, res } = post('key-1');
    await mockRefs.rotateHandler!(req, res);
    expect(rotateUserApiKey).toHaveBeenCalledWith(
      'admin-user',
      { keyId: 'key-1' },
      expect.objectContaining({ callerScopes: undefined })
    );
  });

  it('threads an API keys held scopes through as callerScopes', async () => {
    const { req, res } = post('key-1');
    (req as any).apiKeyInfo = { scopes: ['notebooks:read'] };
    await mockRefs.rotateHandler!(req, res);
    expect(rotateUserApiKey).toHaveBeenCalledWith(
      'admin-user',
      { keyId: 'key-1' },
      expect.objectContaining({ callerScopes: ['notebooks:read'] })
    );
  });

  it('maps an API key with absent scopes to [] (denies), not undefined (skip)', async () => {
    // Fail-open fix: apiKeyInfo present but scopes absent must not read as a browser
    // caller. [] means "holds no scope", so the service denies the escalation.
    const { req, res } = post('key-1');
    (req as any).apiKeyInfo = {}; // scopes undefined
    await mockRefs.rotateHandler!(req, res);
    expect(rotateUserApiKey).toHaveBeenCalledWith(
      'admin-user',
      { keyId: 'key-1' },
      expect.objectContaining({ callerScopes: [] })
    );
  });

  it('calls the re-own notifier with previousOwnerUserId and key name when set', async () => {
    rotateUserApiKey.mockResolvedValueOnce({
      id: 'key-1',
      name: 'k',
      keyPrefix: 'b4m_live_x',
      key: 'b4m_live_secret',
      previousOwnerUserId: 'minter',
    });
    const { req, res } = post('key-1');
    await mockRefs.rotateHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(notifyApiKeyRotationReown).toHaveBeenCalledWith('minter', 'k', req.logger);
  });

  it('skips the re-own notifier when previousOwnerUserId is absent', async () => {
    const { req, res } = post('key-1');
    await mockRefs.rotateHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(notifyApiKeyRotationReown).not.toHaveBeenCalled();
  });

  it('returns 200 with the credential when the notifier does not settle within 5s', async () => {
    rotateUserApiKey.mockResolvedValueOnce({
      id: 'key-1',
      name: 'k',
      keyPrefix: 'b4m_live_x',
      key: 'b4m_live_secret',
      previousOwnerUserId: 'minter',
    });
    // Never-settling notifier simulates a stalled SMTP host.
    notifyApiKeyRotationReown.mockReturnValueOnce(new Promise(() => {}));
    vi.useFakeTimers();
    const { req, res } = post('key-1');
    const handlerP = mockRefs.rotateHandler!(req, res) as Promise<unknown>;
    await vi.advanceTimersByTimeAsync(5_000);
    await handlerP;
    vi.useRealTimers();
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getData()).key).toBe('b4m_live_secret');
  });
});

describe('POST /api/user-api-keys/[id]/revoke', () => {
  beforeEach(() => vi.clearAllMocks());

  it('threads the organizations adapter into revokeUserApiKey and returns 200', async () => {
    const { req, res } = post('key-1', { reason: 'rotated out' });
    await mockRefs.revokeHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(revokeUserApiKey).toHaveBeenCalledWith(
      'admin-user',
      { keyId: 'key-1', reason: 'rotated out' },
      expect.anything()
    );
    const [, , adapters] = revokeUserApiKey.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { db: { organizations: unknown; realtimeConnections: unknown } },
    ];
    expect(adapters.db.organizations).toBe(organizationRepository);
    expect(adapters.db.realtimeConnections).toBe(realtimeConnectionRepository);
  });

  it('propagates a service NotFoundError', async () => {
    revokeUserApiKey.mockRejectedValueOnce(new NotFoundError('API key not found'));
    const { req, res } = post('key-1');
    await expect(mockRefs.revokeHandler!(req, res)).rejects.toThrow(/not found/i);
  });
});

/**
 * Both writes happen after the key change has committed, so they go through the
 * best-effort wrapper with the request logger attached: a failed counter write
 * gets recorded, not turned into a 5xx the client will retry.
 */
describe('rotate and revoke - analytics is best effort', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rotate logs through logEventSafe with the request logger', async () => {
    const { req, res } = post('key-1');
    await mockRefs.rotateHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(logEventSafe).toHaveBeenCalledWith(expect.anything(), expect.anything(), req.logger);
  });

  it('revoke logs through logEventSafe with the request logger', async () => {
    const { req, res } = post('key-1', { reason: 'rotated out' });
    await mockRefs.revokeHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(logEventSafe).toHaveBeenCalledWith(expect.anything(), expect.anything(), req.logger);
  });
});

describe('POST /api/user-api-keys/[id]/rotate - paid-only access switch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects the rotation with 403 and never rotates when the setting denies the caller', async () => {
    isApiKeyAccessAllowedMock.mockResolvedValueOnce(false);
    const { req, res } = post('key-1');
    await expect(mockRefs.rotateHandler!(req, res)).rejects.toThrow('API keys require an active paid subscription');
    expect(rotateUserApiKey).not.toHaveBeenCalled();
  });
});

describe('rotation billing policy wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveOwnedApiKey.mockResolvedValue({ id: 'key-1' });
    isApiKeyAccessAllowedMock.mockResolvedValue(true);
  });

  it('authorizes the key before consulting subscription policy', async () => {
    resolveOwnedApiKey.mockResolvedValueOnce(null);
    const { req, res } = post('other-key');
    await expect(mockRefs.rotateHandler!(req, res)).rejects.toMatchObject({ statusCode: 404 });
    expect(isApiKeyAccessAllowedMock).not.toHaveBeenCalled();
    expect(rotateUserApiKey).not.toHaveBeenCalled();
  });

  it('passes organization billing and admin provisioning provenance from the authorized key', async () => {
    resolveOwnedApiKey.mockResolvedValueOnce({
      id: 'key-1',
      billingOwnerType: 'Organization',
      organizationId: 'org-1',
      metadata: { createdByUserId: 'provisioning-admin' },
    });
    const { req, res } = post('key-1');
    await mockRefs.rotateHandler!(req, res);
    expect(resolveOwnedApiKey).toHaveBeenCalledWith('admin-user', 'key-1', {
      db: { userApiKeys: userApiKeyRepository, organizations: organizationRepository },
    });
    expect(isApiKeyAccessAllowedMock).toHaveBeenCalledWith(
      req.user,
      {
        billingOwnerType: 'Organization',
        organizationId: 'org-1',
        createdByUserId: 'provisioning-admin',
      },
      req
    );
    expect(rotateUserApiKey).toHaveBeenCalledTimes(1);
  });
});
