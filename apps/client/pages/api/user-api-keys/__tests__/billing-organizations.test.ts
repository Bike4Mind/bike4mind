import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mockRefs = vi.hoisted(() => ({ getHandler: null as null | ((req: unknown, res: unknown) => unknown) }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    get: (fn: (req: unknown, res: unknown) => unknown) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const organizationRepository = vi.hoisted(() => ({
  findIdsAdministeredBy: vi.fn().mockResolvedValue(['org-1']),
  findById: vi.fn().mockResolvedValue({ id: 'org-1', name: 'Acme' }),
}));
vi.mock('@bike4mind/database', () => ({ organizationRepository }));

import '@pages/api/user-api-keys/billing-organizations';

function get(user: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'GET' });
  Object.assign(req, { user });
  return { req, res };
}

describe('GET /api/user-api-keys/billing-organizations', () => {
  it('lists the administered organizations for a member', async () => {
    const { req, res } = get({ id: 'u1', isAdmin: false });
    await mockRefs.getHandler!(req, res);
    expect(res._getJSONData()).toEqual([{ id: 'org-1', name: 'Acme' }]);
  });

  it('refuses a service-account caller before any lookup', async () => {
    organizationRepository.findIdsAdministeredBy.mockClear();
    const { req, res } = get({ id: 'sa1', isSystem: true, serviceAccountOrganizationId: 'org-1' });
    await expect(mockRefs.getHandler!(req, res)).rejects.toMatchObject({ statusCode: 403 });
    expect(organizationRepository.findIdsAdministeredBy).not.toHaveBeenCalled();
  });
});
