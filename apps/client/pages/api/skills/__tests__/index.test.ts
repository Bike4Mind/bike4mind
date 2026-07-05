import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@client/server/middlewares/baseApi', () => ({
  baseApi: () => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const fn = (async (req: { method: string }, res: { status: (n: number) => { end: () => void } }) => {
      const handler = handlers[req.method];
      if (!handler) return res.status(405).end();
      return handler(req, res);
    }) as ((req: unknown, res: unknown) => unknown) & Record<string, (h: unknown) => unknown>;
    fn.get = (h: unknown) => ((handlers.GET = h as never), fn);
    fn.post = (h: unknown) => ((handlers.POST = h as never), fn);
    return fn;
  },
}));

const mockCreate = vi.fn();
const mockSearchAccessible = vi.fn();
vi.mock('@bike4mind/database', () => ({
  skillRepository: {
    create: (...a: unknown[]) => mockCreate(...a),
    searchAccessible: (...a: unknown[]) => mockSearchAccessible(...a),
  },
}));

const mockFindIdsAdministeredBy = vi.fn();
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findIdsAdministeredBy: (...a: unknown[]) => mockFindIdsAdministeredBy(...a) },
}));

const mockVerifyOrgAccess = vi.fn();
vi.mock('@server/utils/orgAccess', () => ({
  verifyOrgAccess: (...a: unknown[]) => mockVerifyOrgAccess(...a),
}));

import handler from '@pages/api/skills/index';
import { ForbiddenError } from '@bike4mind/utils';

const USER = 'user-1';
const ORG = '6650000000000000000000aa';

function makeReqRes(body: Record<string, unknown>, isAdmin = false) {
  const { req, res } = createMocks({ method: 'POST', body });
  (req as unknown as { user: unknown }).user = { id: USER, isAdmin };
  return { req, res };
}

const baseBody = { name: 'summarize', description: 'Summarize text', body: 'Summarize: $ARGUMENTS' };

describe('/api/skills POST — scope creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockImplementation(async (doc: Record<string, unknown>) => ({ id: 'new', ...doc }));
    mockVerifyOrgAccess.mockResolvedValue({ id: ORG });
  });

  it('defaults to user-scoped when no scope is supplied', async () => {
    const { req, res } = makeReqRes(baseBody);
    await handler(req, res);
    expect(res._getStatusCode()).toBe(201);
    const doc = mockCreate.mock.calls[0][0];
    expect(doc.userId).toBe(USER);
    expect(doc.organizationId).toBeUndefined();
    expect(doc.isSystem).toBeUndefined();
  });

  it('creates an org-scoped skill when the caller passes org access', async () => {
    const { req, res } = makeReqRes({ ...baseBody, scope: { organizationId: ORG } });
    await handler(req, res);
    expect(mockVerifyOrgAccess).toHaveBeenCalledWith({ id: USER, isAdmin: false }, ORG);
    const doc = mockCreate.mock.calls[0][0];
    expect(doc.organizationId).toBe(ORG);
    expect(doc.userId).toBeUndefined();
  });

  it('rejects org-scoped creation when verifyOrgAccess throws', async () => {
    mockVerifyOrgAccess.mockRejectedValue(new ForbiddenError('no access'));
    const { req, res } = makeReqRes({ ...baseBody, scope: { organizationId: ORG } });
    await expect(handler(req, res)).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects system-scoped creation for a non-admin', async () => {
    const { req, res } = makeReqRes({ ...baseBody, scope: { isSystem: true } }, false);
    await expect(handler(req, res)).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('allows system-scoped creation for a super-admin', async () => {
    const { req, res } = makeReqRes({ ...baseBody, scope: { isSystem: true } }, true);
    await handler(req, res);
    const doc = mockCreate.mock.calls[0][0];
    expect(doc.isSystem).toBe(true);
    expect(doc.userId).toBeUndefined();
  });

  it('rejects a scope that is both org and system', async () => {
    const { req, res } = makeReqRes({ ...baseBody, scope: { organizationId: ORG, isSystem: true } }, true);
    await expect(handler(req, res)).rejects.toBeTruthy();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('/api/skills GET — scope visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchAccessible.mockResolvedValue({ data: [], hasMore: false, total: 0 });
    mockFindIdsAdministeredBy.mockResolvedValue([ORG]);
  });

  function makeGetReqRes(isAdmin = false) {
    const { req, res } = createMocks({ method: 'GET', query: {} });
    (req as unknown as { user: unknown }).user = { id: USER, isAdmin };
    return { req, res };
  }

  it('passes isAdmin + administered org ids as the scope to searchAccessible', async () => {
    const { req, res } = makeGetReqRes(true);
    await handler(req, res);
    expect(mockFindIdsAdministeredBy).toHaveBeenCalledWith(USER);
    const scope = mockSearchAccessible.mock.calls[0][5];
    expect(scope).toEqual({ isAdmin: true, adminOrganizationIds: [ORG] });
  });

  it('passes isAdmin=false for a non-admin caller', async () => {
    const { req, res } = makeGetReqRes(false);
    await handler(req, res);
    const scope = mockSearchAccessible.mock.calls[0][5];
    expect(scope.isAdmin).toBe(false);
  });

  it('redacts the roster of a global-read skill the caller does not manage, but keeps their own', async () => {
    mockFindIdsAdministeredBy.mockResolvedValue([]);
    mockSearchAccessible.mockResolvedValue({
      data: [
        // Owned by caller -> manager -> full roster retained.
        {
          id: 'mine',
          name: 'mine',
          userId: USER,
          users: [{ userId: 'someone', permissions: ['read'] }],
          groups: [{ groupId: 'g1', permissions: ['read'] }],
        },
        // Global-read, owned by another, caller has a plain read share ->
        // not a manager -> roster redacted to the caller's own row only.
        {
          id: 'global',
          name: 'global',
          userId: 'owner-x',
          isGlobalRead: true,
          users: [
            { userId: USER, permissions: ['read'] },
            { userId: 'other', permissions: ['update'] },
          ],
          groups: [{ groupId: 'g2', permissions: ['read'] }],
        },
      ],
      hasMore: false,
      total: 2,
    });

    const { req, res } = makeGetReqRes(false);
    await handler(req, res);
    const body = res._getJSONData();

    const mine = body.data.find((s: { id: string }) => s.id === 'mine');
    expect(mine.users).toHaveLength(1); // owner sees the full roster
    expect(mine.groups).toBeDefined();

    const global = body.data.find((s: { id: string }) => s.id === 'global');
    expect(global.users).toEqual([{ userId: USER, permissions: ['read'] }]); // own row only
    expect(global.groups).toBeUndefined(); // groups stripped
  });
});
