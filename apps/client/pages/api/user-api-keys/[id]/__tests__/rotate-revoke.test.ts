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
vi.mock('@bike4mind/services', () => ({ userApiKeyService: { rotateUserApiKey, revokeUserApiKey } }));

const userApiKeyRepository = vi.hoisted(() => ({}));
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository }));
const organizationRepository = vi.hoisted(() => ({ findIdsAdministeredBy: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ organizationRepository }));
const logEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent }));

import { NotFoundError } from '@server/utils/errors';
// Order matters: the first baseApi() call is rotate, the second is revoke.
import '@pages/api/user-api-keys/[id]/rotate';
import '@pages/api/user-api-keys/[id]/revoke';

function post(id: string | undefined, body: unknown = {}) {
  const { req, res } = createMocks({ method: 'POST', query: id === undefined ? {} : { id }, body });
  (req as any).user = { id: 'admin-user', isAdmin: false };
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
      expect.objectContaining({ db: expect.objectContaining({ organizations: organizationRepository }) })
    );
  });

  it('propagates a service NotFoundError', async () => {
    rotateUserApiKey.mockRejectedValueOnce(new NotFoundError('API key not found'));
    const { req, res } = post('key-1');
    await expect(mockRefs.rotateHandler!(req, res)).rejects.toThrow(/not found/i);
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
      expect.objectContaining({ db: expect.objectContaining({ organizations: organizationRepository }) })
    );
  });

  it('propagates a service NotFoundError', async () => {
    revokeUserApiKey.mockRejectedValueOnce(new NotFoundError('API key not found'));
    const { req, res } = post('key-1');
    await expect(mockRefs.revokeHandler!(req, res)).rejects.toThrow(/not found/i);
  });
});
