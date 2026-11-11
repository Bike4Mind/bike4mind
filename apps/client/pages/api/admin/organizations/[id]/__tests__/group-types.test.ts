// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    use() {
      return this;
    },
    put: (fn: unknown) => fn,
  }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));

const mockSetGroupTypes = vi.fn();
let transactionActive = false;
const mockTransaction = vi.fn(async (fn: () => Promise<unknown>) => {
  transactionActive = true;
  try {
    return await fn();
  } finally {
    transactionActive = false;
  }
});
vi.mock('@bike4mind/services', () => ({
  organizationService: { setOrganizationGroupTypes: (...args: unknown[]) => mockSetGroupTypes(...args) },
}));
vi.mock('@bike4mind/database', () => ({
  organizationRepository: {},
  userRepository: {},
  withTransaction: (fn: () => Promise<unknown>) => mockTransaction(fn),
}));
vi.mock('@bike4mind/database/social', () => ({ groupRepository: {} }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>()),
  recordAdminActionFromRequest: vi.fn().mockResolvedValue(null),
}));

import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import handler from '../group-types';

type HandlerFn = (req: unknown, res: unknown) => Promise<unknown>;

describe('PUT /api/admin/organizations/[id]/group-types', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetGroupTypes.mockResolvedValue({ added: ['team'], removed: [], revokedGroupIds: [] });
    vi.mocked(recordAdminActionFromRequest).mockImplementation(async () => {
      expect(transactionActive).toBe(true);
      return null;
    });
  });

  it('records the reasoned org.group_types.updated inside the transaction', async () => {
    const { req, res } = createMocks({
      method: 'PUT',
      query: { id: 'org-1' },
      body: { allowedGroupTypes: ['team'], reason: 'Customer request' },
    });
    (req as unknown as Record<string, unknown>).user = { id: 'admin-1', username: 'admin', isAdmin: true };

    await (handler as HandlerFn)(req, res);

    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'org.group_types.updated',
        target: expect.objectContaining({ kind: 'organization', id: 'org-1' }),
        reason: 'Customer request',
        details: { added: ['team'], removed: [], revokedGroupIds: [] },
      })
    );
    expect(mockTransaction).toHaveBeenCalledOnce();
    expect(mockSetGroupTypes.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(recordAdminActionFromRequest).mock.invocationCallOrder[0]
    );
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['missing', {}],
    ['too short', { reason: 'no' }],
    ['blank', { reason: '   ' }],
  ])('rejects a %s reason before the transaction or service write', async (_label, extra) => {
    const { req, res } = createMocks({
      method: 'PUT',
      query: { id: 'org-1' },
      body: { allowedGroupTypes: ['team'], ...extra },
    });
    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockSetGroupTypes).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('rejects the transaction if its audit write fails', async () => {
    const { req, res } = createMocks({
      method: 'PUT',
      query: { id: 'org-1' },
      body: { allowedGroupTypes: ['team'], reason: 'Customer request' },
    });
    vi.mocked(recordAdminActionFromRequest).mockRejectedValueOnce(new Error('audit unavailable'));

    await expect((handler as HandlerFn)(req, res)).rejects.toThrow('audit unavailable');
    expect(mockTransaction).toHaveBeenCalledOnce();
    expect(res._isEndCalled()).toBe(false);
  });
});
