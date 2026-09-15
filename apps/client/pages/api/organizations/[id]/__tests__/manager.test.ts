import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ForbiddenError } from '@server/utils/errors';

/**
 * POST/DELETE /api/organizations/[id]/manager delegate to organizationService
 * but keep the billing-owner/admin gate in the route. These assert both the
 * delegation (allow path) and that a non-owner/non-admin is rejected before the
 * service is ever called (deny path).
 */

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: any, res: any) => unknown),
  deleteHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: () => chain,
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
    delete: (fn: any) => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const assignManager = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const removeManager = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@bike4mind/services', () => ({ organizationService: { assignManager, removeManager } }));

const findById = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: { findById } }));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: {} }));

import '@pages/api/organizations/[id]/manager';

describe('/api/organizations/[id]/manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findById.mockResolvedValue({ id: 'org1', userId: 'owner1' });
  });

  describe('POST (assign)', () => {
    it('lets the billing owner assign a manager and delegates to the service', async () => {
      const { req, res } = createMocks({ method: 'POST', query: { id: 'org1' }, body: { managerId: 'mgr1' } });
      (req as any).user = { id: 'owner1', isAdmin: false };
      await mockRefs.postHandler!(req, res);

      expect(assignManager).toHaveBeenCalledWith(
        { organizationId: 'org1', managerId: 'mgr1' },
        expect.objectContaining({ db: expect.any(Object) })
      );
      expect(res._getStatusCode()).toBe(200);
    });

    it('lets an admin assign a manager', async () => {
      const { req, res } = createMocks({ method: 'POST', query: { id: 'org1' }, body: { managerId: 'mgr1' } });
      (req as any).user = { id: 'someone-else', isAdmin: true };
      await mockRefs.postHandler!(req, res);
      expect(assignManager).toHaveBeenCalledTimes(1);
    });

    it('rejects a non-owner, non-admin before calling the service', async () => {
      const { req, res } = createMocks({ method: 'POST', query: { id: 'org1' }, body: { managerId: 'mgr1' } });
      (req as any).user = { id: 'intruder', isAdmin: false };
      await expect(mockRefs.postHandler!(req, res)).rejects.toThrow(ForbiddenError);
      expect(assignManager).not.toHaveBeenCalled();
    });
  });

  describe('DELETE (remove)', () => {
    it('lets the billing owner remove the manager and delegates to the service', async () => {
      const { req, res } = createMocks({ method: 'DELETE', query: { id: 'org1' } });
      (req as any).user = { id: 'owner1', isAdmin: false };
      await mockRefs.deleteHandler!(req, res);

      expect(removeManager).toHaveBeenCalledWith(
        { organizationId: 'org1' },
        expect.objectContaining({ db: expect.any(Object) })
      );
      expect(res._getStatusCode()).toBe(200);
    });

    it('rejects a non-owner, non-admin before calling the service', async () => {
      const { req, res } = createMocks({ method: 'DELETE', query: { id: 'org1' } });
      (req as any).user = { id: 'intruder', isAdmin: false };
      await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow(ForbiddenError);
      expect(removeManager).not.toHaveBeenCalled();
    });
  });
});
