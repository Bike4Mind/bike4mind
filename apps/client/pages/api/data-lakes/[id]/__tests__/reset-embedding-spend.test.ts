import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  resetEmbeddingSpend: vi.fn(),
  findById: vi.fn(),
  deleteForLake: vi.fn(async () => 0),
  recordAdminAction: vi.fn(),
  inTransaction: false,
  findOrganization: vi.fn(),
  assertUser: vi.fn(),
  assertOrganization: vi.fn(),
  resolveCanManageLake: vi.fn(),
  toMemberAccessContext: vi.fn(),
  insideTransactionAtAudit: undefined as boolean | undefined,
}));

type Handler = (req: { method?: string }, res: unknown, next: () => void) => unknown;
type Invocable = (req: unknown, res: unknown) => unknown;

const mockRefs = vi.hoisted(() => ({ getHandler: null as null | Invocable, postHandler: null as null | Invocable }));

// The chain runs adminApi's real permission guard (and any other use() middleware) ahead of the handler.
vi.mock('@server/middlewares/baseApi', () => {
  const guards: Handler[] = [];
  const gated = (method: string, fn: Invocable) => async (req: { method?: string }, res: unknown) => {
    req.method = method;
    for (const guard of guards) guard(req, res, () => {});
    return fn(req, res);
  };
  const chain = {
    use: (fn: Handler) => {
      guards.push(fn);
      return chain;
    },
    get: (fn: Invocable) => {
      mockRefs.getHandler = gated('GET', fn);
      return chain;
    },
    post: (fn: Invocable) => {
      mockRefs.postHandler = gated('POST', fn);
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({
  requireFeatureEnabled: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeAccessGrantRepository: { listByLake: vi.fn() },
  dataLakeRepository: { resetEmbeddingSpend: h.resetEmbeddingSpend, findById: h.findById },
  dataLakeSpendNotificationRepository: { deleteForLake: h.deleteForLake },
  organizationRepository: { findById: h.findOrganization },
  withTransaction: async (fn: () => Promise<unknown>) => {
    h.inTransaction = true;
    try {
      return await fn();
    } finally {
      h.inTransaction = false;
    }
  },
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  recordAdminActionFromRequest: (...args: unknown[]) => {
    h.insideTransactionAtAudit = h.inTransaction;
    return h.recordAdminAction(...args);
  },
}));

vi.mock('@bike4mind/services', () => ({ dataLakeService: { resolveCanManageLake: h.resolveCanManageLake } }));
vi.mock('@bike4mind/server-utils/dataLakes/toAccessContext', () => ({
  toMemberAccessContext: h.toMemberAccessContext,
}));

// The target rules themselves are covered by delegateTargets' own tests; here only that the route applies them.
vi.mock('@server/admin/creditGrants/delegateTargets', () => ({
  assertDelegateCanCreditUser: h.assertUser,
  assertDelegateCanCreditOrganization: h.assertOrganization,
}));

import '../reset-embedding-spend';

const handler = (req: unknown, res: unknown) => mockRefs.postHandler!(req, res);

const makeRes = () => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
};
const makeReq = (isAdmin: boolean, adminPermissions?: string[]) =>
  ({
    method: 'POST',
    query: { id: 'lake-1' },
    user: { id: 'admin-1', isAdmin, adminPermissions },
    logger: { log: vi.fn(), warn: vi.fn() },
  }) as never;

const LAKE = {
  id: 'lake-1',
  name: 'Research',
  organizationId: 'org-1',
  createdByUserId: 'owner-1',
  embeddingSpendMicroUsd: 4200,
};

const ORGANIZATION = { id: 'org-1', userId: 'org-owner-1' };
const MEMBER_CONTEXT = { userId: 'admin-1', isAdmin: false, administeredOrgIds: [] };

beforeEach(() => {
  vi.clearAllMocks();
  h.findById.mockResolvedValue(LAKE);
  h.recordAdminAction.mockResolvedValue(null);
  h.insideTransactionAtAudit = undefined;
  h.findOrganization.mockResolvedValue(ORGANIZATION);
  h.resolveCanManageLake.mockResolvedValue(false);
  h.toMemberAccessContext.mockResolvedValue(MEMBER_CONTEXT);
});

describe('POST /api/data-lakes/[id]/reset-embedding-spend', () => {
  it('resets the meter for an admin', async () => {
    h.resetEmbeddingSpend.mockResolvedValue(true);
    const res = makeRes();
    await handler(makeReq(true), res);

    expect(h.resetEmbeddingSpend).toHaveBeenCalledWith('lake-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('refuses a signed-in non-admin before touching the meter', async () => {
    await expect(handler(makeReq(false), makeRes())).rejects.toThrow('Missing permission: credits:adjust');
    expect(h.resetEmbeddingSpend).not.toHaveBeenCalled();
  });

  it('admits a delegate holding credits:adjust', async () => {
    h.resetEmbeddingSpend.mockResolvedValue(true);
    const res = makeRes();
    await handler(makeReq(false, ['credits:adjust']), res);

    expect(h.resetEmbeddingSpend).toHaveBeenCalledWith('lake-1');
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('refuses a delegate holding an unrelated permission', async () => {
    await expect(handler(makeReq(false, ['users:moderate']), makeRes())).rejects.toThrow(
      'Missing permission: credits:adjust'
    );
    expect(h.resetEmbeddingSpend).not.toHaveBeenCalled();
  });

  it('checks the lake creator and its organization as credit targets', async () => {
    h.resetEmbeddingSpend.mockResolvedValue(true);
    const req = makeReq(false, ['credits:adjust']);
    await handler(req, makeRes());

    const actor = (req as unknown as { user: unknown }).user;
    expect(h.assertUser).toHaveBeenCalledWith(actor, 'owner-1', 'reset embedding spend for');
    expect(h.findOrganization).toHaveBeenCalledWith('org-1');
    expect(h.assertOrganization).toHaveBeenCalledWith(actor, ORGANIZATION, 'reset embedding spend for');
  });

  it.each([
    [
      'the lake creator',
      () => h.assertUser.mockRejectedValueOnce(new Error('You cannot reset embedding spend for your own account')),
    ],
    [
      'its organization',
      () =>
        h.assertOrganization.mockRejectedValueOnce(
          new Error('You cannot reset embedding spend for an organization you belong to')
        ),
    ],
  ])('leaves the meter alone when the delegate may not credit %s', async (_label, refuse) => {
    refuse();
    await expect(handler(makeReq(false, ['credits:adjust']), makeRes())).rejects.toThrow(
      /You cannot reset embedding spend/
    );
    expect(h.resetEmbeddingSpend).not.toHaveBeenCalled();
    expect(h.recordAdminAction).not.toHaveBeenCalled();
  });

  it('refuses a delegate who could manage the lake as a member (owner/curator grant, org admin)', async () => {
    h.resolveCanManageLake.mockResolvedValue(true);
    const req = makeReq(false, ['credits:adjust']);
    await expect(handler(req, makeRes())).rejects.toThrow(
      'You cannot reset embedding spend for a data lake you manage'
    );

    expect(h.toMemberAccessContext).toHaveBeenCalledWith(req);
    expect(h.resolveCanManageLake).toHaveBeenCalledWith(LAKE, MEMBER_CONTEXT, expect.anything());
    expect(h.resetEmbeddingSpend).not.toHaveBeenCalled();
    expect(h.recordAdminAction).not.toHaveBeenCalled();
  });

  it('skips the delegate target checks for a full admin', async () => {
    h.resetEmbeddingSpend.mockResolvedValue(true);
    h.resolveCanManageLake.mockResolvedValue(true);
    await handler(makeReq(true), makeRes());

    expect(h.resolveCanManageLake).not.toHaveBeenCalled();
    expect(h.assertUser).not.toHaveBeenCalled();
    expect(h.resetEmbeddingSpend).toHaveBeenCalledWith('lake-1');
  });

  it('skips the organization check for a lake with no organization', async () => {
    h.resetEmbeddingSpend.mockResolvedValue(true);
    h.findById.mockResolvedValue({ ...LAKE, organizationId: undefined });
    await handler(makeReq(false, ['credits:adjust']), makeRes());

    expect(h.findOrganization).not.toHaveBeenCalled();
    expect(h.assertOrganization).not.toHaveBeenCalled();
  });

  it('404s on an unknown lake', async () => {
    h.findById.mockResolvedValue(null);
    await expect(handler(makeReq(true), makeRes())).rejects.toThrow(/not found/);
    expect(h.deleteForLake).not.toHaveBeenCalled();
  });

  it('re-arms the lake-scope spend notice after a successful reset', async () => {
    h.resetEmbeddingSpend.mockResolvedValue(true);
    const res = makeRes();
    await handler(makeReq(true), res);

    // Scoped to 'lake' only - a period/run/switch notice for the same lake must survive a reset.
    expect(h.deleteForLake).toHaveBeenCalledWith('lake-1', 'lake');
  });

  it('a re-arm failure is logged, never fails the reset request', async () => {
    h.resetEmbeddingSpend.mockResolvedValue(true);
    h.deleteForLake.mockRejectedValueOnce(new Error('mongo down'));
    const res = makeRes();

    await expect(handler(makeReq(true), res)).resolves.toBeUndefined();
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it('records org.data_lake.embedding_spend_reset with the zeroed meter inside the transaction', async () => {
    h.resetEmbeddingSpend.mockResolvedValue(true);
    await handler(makeReq(true), makeRes());

    expect(h.insideTransactionAtAudit).toBe(true);
    expect(h.recordAdminAction).toHaveBeenCalledTimes(1);
    expect(h.recordAdminAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'org.data_lake.embedding_spend_reset',
        target: expect.objectContaining({ kind: 'settings', id: 'lake-1' }),
        organizationId: 'org-1',
        changes: [{ field: 'embeddingSpendMicroUsd', before: 4200, after: 0 }],
      })
    );
  });

  it('fails the request and skips the re-arm when the audit write fails', async () => {
    h.resetEmbeddingSpend.mockResolvedValue(true);
    h.recordAdminAction.mockRejectedValueOnce(new Error('audit down'));
    const res = makeRes();

    await expect(handler(makeReq(true), res)).rejects.toThrow('audit down');
    expect(res.status).not.toHaveBeenCalled();
    expect(h.deleteForLake).not.toHaveBeenCalled();
  });
});
