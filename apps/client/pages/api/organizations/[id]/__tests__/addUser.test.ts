import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ForbiddenError, NotFoundError } from '@server/utils/errors';

/**
 * POST /api/organizations/[id]/addUser gained an explicit billing-owner/admin
 * gate during the organizationManager consolidation (the route was previously
 * unauthenticated). These assert the gate (deny path) and delegation to
 * organizationService.addMember (allow path).
 */

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: () => chain,
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
    delete: () => chain,
  };
  return { baseApi: () => chain };
});

const addMember = vi.hoisted(() => vi.fn().mockResolvedValue({ organization: {}, user: {} }));
vi.mock('@bike4mind/services', () => ({ organizationService: { addMember } }));

const findById = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: { findById } }));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: {} }));
vi.mock('@bike4mind/database', () => ({ withTransaction: (fn: any) => fn() }));

import '@pages/api/organizations/[id]/addUser';

describe('POST /api/organizations/[id]/addUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findById.mockResolvedValue({ id: 'org1', userId: 'owner1' });
  });

  it('lets the billing owner add a user and delegates to addMember', async () => {
    const { req, res } = createMocks({ method: 'POST', query: { id: 'org1' }, body: { userId: 'u1' } });
    (req as any).user = { id: 'owner1', isAdmin: false };
    await mockRefs.postHandler!(req, res);

    expect(addMember).toHaveBeenCalledWith(
      req.user,
      { organizationId: 'org1', userId: 'u1' },
      expect.objectContaining({ db: expect.any(Object) })
    );
    expect(res._getStatusCode()).toBe(200);
  });

  it('lets an admin add a user', async () => {
    const { req, res } = createMocks({ method: 'POST', query: { id: 'org1' }, body: { userId: 'u1' } });
    (req as any).user = { id: 'someone-else', isAdmin: true };
    await mockRefs.postHandler!(req, res);
    expect(addMember).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-owner, non-admin before calling addMember', async () => {
    const { req, res } = createMocks({ method: 'POST', query: { id: 'org1' }, body: { userId: 'u1' } });
    (req as any).user = { id: 'intruder', isAdmin: false };
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(ForbiddenError);
    expect(addMember).not.toHaveBeenCalled();
  });

  it('rejects with NotFoundError when the organization does not exist', async () => {
    findById.mockResolvedValue(null);
    const { req, res } = createMocks({ method: 'POST', query: { id: 'ghost' }, body: { userId: 'u1' } });
    (req as any).user = { id: 'owner1', isAdmin: false };
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(NotFoundError);
    expect(addMember).not.toHaveBeenCalled();
  });
});
