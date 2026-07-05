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
    fn.put = (h: unknown) => ((handlers.PUT = h as never), fn);
    return fn;
  },
}));

const mockFindById = vi.fn();
const mockUpdate = vi.fn();
vi.mock('@bike4mind/database', () => ({
  skillRepository: {
    findById: (...a: unknown[]) => mockFindById(...a),
    update: (...a: unknown[]) => mockUpdate(...a),
  },
}));

// skillAccess pulls organizationRepository for the org-admin override.
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findById: vi.fn().mockResolvedValue(null) },
}));

import handler from '@pages/api/skills/[id]/share';
import { ForbiddenError } from '@bike4mind/utils';

const OWNER = 'owner-1';
const SHARER = 'sharer-1';
const OUTSIDER = 'rando-1';

function skillDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'skill-1',
    name: 'summarize',
    userId: OWNER,
    users: [{ userId: SHARER, permissions: ['share'] }],
    isGlobalRead: false,
    isGlobalWrite: false,
    ...overrides,
  };
}

function makeReqRes(userId: string, body: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'PUT', query: { id: 'skill-1' }, body });
  (req as unknown as { user: unknown }).user = { id: userId, isAdmin: false };
  return { req, res };
}

describe('/api/skills/[id]/share', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue(skillDoc());
    mockUpdate.mockImplementation(async (patch: Record<string, unknown>) => ({ ...skillDoc(), ...patch }));
  });

  it('lets the owner replace the share list', async () => {
    const { req, res } = makeReqRes(OWNER, {
      users: [{ userId: 'new-user', permissions: ['read', 'update'] }],
      isGlobalRead: true,
    });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    const patch = mockUpdate.mock.calls[0][0];
    expect(patch.users).toEqual([{ userId: 'new-user', permissions: ['read', 'update'] }]);
    expect(patch.isGlobalRead).toBe(true);
  });

  it('rejects a bare share-grantee — management is owner/admin/org-admin only', async () => {
    // A `share` grant does NOT confer management: honoring it let the grantee
    // flip global-write or self-elevate (privilege escalation). See skillAccess.
    const { req, res } = makeReqRes(SHARER, { users: [] });
    await expect(handler(req, res)).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects a share-grantee trying to escalate via isGlobalWrite', async () => {
    const { req, res } = makeReqRes(SHARER, { isGlobalWrite: true });
    await expect(handler(req, res)).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects a share-grantee trying to self-grant elevated permissions', async () => {
    const { req, res } = makeReqRes(SHARER, {
      users: [{ userId: SHARER, permissions: ['update', 'delete', 'share'] }],
    });
    await expect(handler(req, res)).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('lets a super-admin manage sharing', async () => {
    const { req, res } = createMocks({ method: 'PUT', query: { id: 'skill-1' }, body: { isGlobalRead: true } });
    (req as unknown as { user: unknown }).user = { id: 'admin-1', isAdmin: true };
    await handler(req, res);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('rejects a user with no access at all', async () => {
    const { req, res } = makeReqRes(OUTSIDER, { users: [] });
    await expect(handler(req, res)).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('drops a self-share on the owner and de-dupes by userId (last wins)', async () => {
    const { req, res } = makeReqRes(OWNER, {
      users: [
        { userId: OWNER, permissions: ['read'] }, // self-share — stripped
        { userId: 'dup', permissions: ['read'] },
        { userId: 'dup', permissions: ['update', 'delete'] }, // last wins
      ],
    });
    await handler(req, res);
    const patch = mockUpdate.mock.calls[0][0];
    expect(patch.users).toEqual([{ userId: 'dup', permissions: ['update', 'delete'] }]);
  });

  it('coerces isGlobalRead to true when isGlobalWrite is set (write implies read)', async () => {
    // The API otherwise accepts the flags à la carte; enforce the invariant the
    // UI couples so a direct caller can't persist global-write without global-read.
    const { req, res } = makeReqRes(OWNER, { isGlobalWrite: true, isGlobalRead: false });
    await handler(req, res);
    const patch = mockUpdate.mock.calls[0][0];
    expect(patch.isGlobalWrite).toBe(true);
    expect(patch.isGlobalRead).toBe(true);
  });

  it('rejects a user-share with no permissions (schema requires at least one)', async () => {
    const { req, res } = makeReqRes(OWNER, { users: [{ userId: 'x', permissions: [] }] });
    await expect(handler(req, res)).rejects.toBeTruthy();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
