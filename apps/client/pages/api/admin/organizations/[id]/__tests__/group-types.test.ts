// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ put: (fn: unknown) => fn }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));

const mockSetGroupTypes = vi.fn();
vi.mock('@bike4mind/services', () => ({
  organizationService: { setOrganizationGroupTypes: (...args: unknown[]) => mockSetGroupTypes(...args) },
}));
vi.mock('@bike4mind/database', () => ({
  organizationRepository: {},
  userRepository: {},
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/database/social', () => ({ groupRepository: {} }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn().mockResolvedValue(null) }));

import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import handler from '../group-types';

type HandlerFn = (req: unknown, res: unknown) => Promise<unknown>;

describe('PUT /api/admin/organizations/[id]/group-types', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetGroupTypes.mockResolvedValue({ added: ['team'], removed: [], revokedGroupIds: [] });
  });

  it('records org.group_types.updated against the organization after the transaction commits', async () => {
    const { req, res } = createMocks({
      method: 'PUT',
      query: { id: 'org-1' },
      body: { allowedGroupTypes: ['team'] },
    });
    (req as unknown as Record<string, unknown>).user = { id: 'admin-1', username: 'admin', isAdmin: true };

    await (handler as HandlerFn)(req, res);

    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'org.group_types.updated',
        target: expect.objectContaining({ kind: 'organization', id: 'org-1' }),
      })
    );
    expect(res.statusCode).toBe(200);
  });
});
