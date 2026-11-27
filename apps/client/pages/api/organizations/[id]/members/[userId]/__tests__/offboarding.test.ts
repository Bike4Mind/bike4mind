import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { createMocks, type RequestMethod } from 'node-mocks-http';
import { NotFoundError } from '@bike4mind/common';

type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;
type Chain = { get: (fn: Handler) => Chain };

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | Handler,
  baseApiOptions: undefined as unknown,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: Chain = {
    get: fn => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return {
    baseApi: (options?: unknown) => {
      mockRefs.baseApiOptions = options;
      return chain;
    },
  };
});

const getMemberOffboardingInventory = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', () => ({ organizationService: { getMemberOffboardingInventory } }));
vi.mock('@bike4mind/database', () => ({
  agentRepository: {},
  artifactRepository: {},
  fabFileRepository: {},
  projectRepository: {},
  sessionRepository: {},
}));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: {} }));
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: {} }));
vi.mock('@bike4mind/database/social', () => ({ groupRepository: {} }));

import '@pages/api/organizations/[id]/members/[userId]/offboarding';

const actor = { id: 'owner1', isAdmin: false };

const request = (query: Record<string, string | string[]> = { id: 'org1', userId: 'member2' }) => {
  const method: RequestMethod = 'GET';
  const { req, res } = createMocks<NextApiRequest & { user: typeof actor }, NextApiResponse>({ method, query });
  req.user = actor;
  return { req, res };
};

describe('GET /api/organizations/[id]/members/[userId]/offboarding', () => {
  beforeEach(() => {
    getMemberOffboardingInventory.mockReset();
  });

  it('is session-only, so an API key cannot list a member content', () => {
    expect(mockRefs.baseApiOptions).toEqual({ auth: 'jwtOnly' });
  });

  it('returns the inventory for the requested member', async () => {
    const inventory = { files: { count: 1, sample: [] }, orgBilledApiKeys: { count: 0 } };
    getMemberOffboardingInventory.mockResolvedValue(inventory);
    const { req, res } = request();

    await mockRefs.getHandler!(req, res);

    expect(getMemberOffboardingInventory).toHaveBeenCalledWith(
      actor,
      { id: 'org1', userId: 'member2' },
      expect.objectContaining({ db: expect.objectContaining({ userApiKeys: expect.anything() }) })
    );
    expect(res._getJSONData()).toEqual(inventory);
  });

  it('rejects a malformed query before reaching the service', async () => {
    const { req, res } = request({ id: 'org1', userId: ['a', 'b'] });

    await expect(mockRefs.getHandler!(req, res)).rejects.toThrow('Organization and user id required');
    expect(getMemberOffboardingInventory).not.toHaveBeenCalled();
  });

  it('propagates the service refusal (not-found for a non-member)', async () => {
    getMemberOffboardingInventory.mockRejectedValue(new NotFoundError('Organization not found'));
    const { req, res } = request();

    await expect(mockRefs.getHandler!(req, res)).rejects.toMatchObject({
      message: 'Organization not found',
      statusCode: 404,
    });
  });
});
