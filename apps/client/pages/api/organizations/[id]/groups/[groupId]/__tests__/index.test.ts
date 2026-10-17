import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * PATCH /api/organizations/[id]/groups/[groupId]: the route delegates to
 * organizationService.renameGroup and returns the group through the response schema, so the
 * schema is what decides which keys of the stored document reach the client.
 */

const mockRefs = vi.hoisted(() => ({
  patchHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: () => chain,
    post: () => chain,
    put: () => chain,
    delete: () => chain,
    patch: (fn: any) => {
      mockRefs.patchHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const renameGroup = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: {} }));
vi.mock('@bike4mind/database/social', () => ({ groupRepository: {} }));
vi.mock('@bike4mind/services', () => ({ organizationService: { renameGroup } }));

import '@pages/api/organizations/[id]/groups/[groupId]/index';

const call = (body: unknown = { name: 'Renamed' }) => {
  const { req, res } = createMocks({ method: 'PATCH', query: { id: 'org1', groupId: 'g1' }, body: body as object });
  (req as any).user = { id: 'owner1' };
  return { res, promise: mockRefs.patchHandler!(req, res) };
};

describe('PATCH /api/organizations/[id]/groups/[groupId]', () => {
  beforeEach(() => {
    renameGroup.mockReset();
  });

  it('strips undeclared group keys and keeps declared fields', async () => {
    renameGroup.mockResolvedValue({
      id: 'g1',
      name: 'Renamed',
      type: 'sales',
      organizationId: 'org1',
      _id: 'raw-object-id',
      __v: 4,
      notInSchema: 'secret',
    });
    const { res, promise } = call();
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const { group } = res._getJSONData();
    expect(group).toEqual({ id: 'g1', name: 'Renamed', type: 'sales', organizationId: 'org1' });
    for (const key of ['_id', '__v', 'notInSchema']) {
      expect(group).not.toHaveProperty(key);
    }
  });

  it('404s when the group vanished between the existence check and the update', async () => {
    renameGroup.mockResolvedValue(null);
    const { promise } = call();

    await expect(promise).rejects.toThrow(/Group not found/);
  });
});
