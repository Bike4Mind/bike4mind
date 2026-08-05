import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  deleteHandler: null as null | ((req: any, res: any) => unknown),
  userRepository: { update: vi.fn() },
  clearActiveOrganization: vi.fn(async () => undefined),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: () => chain,
    delete: (fn: any) => {
      h.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (handler: (...a: unknown[]) => unknown) => handler,
}));
vi.mock('@bike4mind/database', () => ({ User: {}, userRepository: h.userRepository }));
vi.mock('@bike4mind/services', () => ({ organizationService: { clearActiveOrganization: h.clearActiveOrganization } }));
vi.mock('@bike4mind/common', () => ({ toSafeOrganization: (o: unknown) => o }));

import '@pages/api/users/[id]/organization';

describe('DELETE /api/users/[id]/organization - clear the active-org pointer (#1428 escape)', () => {
  beforeEach(() => h.clearActiveOrganization.mockClear());

  it('delegates to clearActiveOrganization with the caller and target userId, then 204s', async () => {
    const { req, res } = createMocks({ method: 'DELETE', query: { id: 'u1' } });
    (req as any).user = { id: 'u1', isAdmin: false };

    await h.deleteHandler!(req, res);

    // authz (self-or-admin) lives in the service; the route just forwards the caller + target.
    expect(h.clearActiveOrganization).toHaveBeenCalledWith(
      { id: 'u1', isAdmin: false },
      { userId: 'u1' },
      { db: { users: h.userRepository } }
    );
    expect(res.statusCode).toBe(204);
  });
});
