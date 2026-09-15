import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Chainable baseApi mock: capture per-method handlers and dispatch by req.method.
vi.mock('@client/server/middlewares/baseApi', () => ({
  baseApi: () => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const fn = (async (req: { method: string }, res: { status: (n: number) => { end: () => void } }) => {
      const handler = handlers[req.method];
      if (!handler) return res.status(405).end();
      return handler(req, res);
    }) as ((req: unknown, res: unknown) => unknown) & Record<string, (h: unknown) => unknown>;
    fn.get = (h: unknown) => ((handlers.GET = h as never), fn);
    fn.put = (h: unknown) => ((handlers.PUT = h as never), fn);
    fn.delete = (h: unknown) => ((handlers.DELETE = h as never), fn);
    return fn;
  },
}));

const mockFindById = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
vi.mock('@bike4mind/database', () => ({
  skillRepository: {
    findById: (...a: unknown[]) => mockFindById(...a),
    update: (...a: unknown[]) => mockUpdate(...a),
    delete: (...a: unknown[]) => mockDelete(...a),
  },
}));

// skillAccess pulls organizationRepository for the org-admin override; no skill
// here is org-scoped, so findById is never reached, but the import must resolve.
const mockOrgFindById = vi.fn().mockResolvedValue(null);
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
}));

import handler from '@pages/api/skills/[id]/index';
import { ForbiddenError } from '@bike4mind/utils';

const OWNER = 'owner-1';
const SHARED_UPDATE = 'editor-1';
const SHARED_DELETE = 'deleter-1';
const OUTSIDER = 'rando-1';

function skillDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'skill-1',
    name: 'summarize',
    description: 'd',
    body: 'b',
    userId: OWNER,
    users: [
      { userId: SHARED_UPDATE, permissions: ['update'] },
      { userId: SHARED_DELETE, permissions: ['delete'] },
    ],
    isGlobalRead: false,
    isGlobalWrite: false,
    ...overrides,
  };
}

function makeReqRes(method: string, userId: string, body: Record<string, unknown> = {}) {
  const { req, res } = createMocks({ method: method as 'PUT', query: { id: 'skill-1' }, body });
  (req as unknown as { user: unknown }).user = { id: userId, isAdmin: false };
  return { req, res };
}

describe('/api/skills/[id] PUT — edit permission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue(skillDoc());
    mockUpdate.mockImplementation(async (patch: Record<string, unknown>) => ({ ...skillDoc(), ...patch }));
  });

  it('allows the owner to edit', async () => {
    const { req, res } = makeReqRes('PUT', OWNER, { description: 'new' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('allows a share-recipient with update permission to edit', async () => {
    const { req, res } = makeReqRes('PUT', SHARED_UPDATE, { description: 'new' });
    await handler(req, res);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('allows editing when the skill is globally writable', async () => {
    mockFindById.mockResolvedValue(skillDoc({ isGlobalWrite: true, users: [] }));
    const { req, res } = makeReqRes('PUT', OUTSIDER, { description: 'new' });
    await handler(req, res);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('rejects a recipient with only delete permission', async () => {
    const { req, res } = makeReqRes('PUT', SHARED_DELETE, { description: 'new' });
    await expect(handler(req, res)).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects an outsider', async () => {
    const { req, res } = makeReqRes('PUT', OUTSIDER, { description: 'new' });
    await expect(handler(req, res)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('/api/skills/[id] DELETE — delete permission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue(skillDoc());
    mockDelete.mockResolvedValue(undefined);
  });

  it('allows the owner to delete', async () => {
    const { req, res } = makeReqRes('DELETE', OWNER);
    await handler(req, res);
    expect(res._getStatusCode()).toBe(204);
    expect(mockDelete).toHaveBeenCalledWith('skill-1');
  });

  it('allows a share-recipient with delete permission', async () => {
    const { req, res } = makeReqRes('DELETE', SHARED_DELETE);
    await handler(req, res);
    expect(mockDelete).toHaveBeenCalled();
  });

  it('rejects a recipient with only update permission', async () => {
    const { req, res } = makeReqRes('DELETE', SHARED_UPDATE);
    await expect(handler(req, res)).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('does NOT grant delete via isGlobalWrite', async () => {
    mockFindById.mockResolvedValue(skillDoc({ isGlobalWrite: true, users: [] }));
    const { req, res } = makeReqRes('DELETE', OUTSIDER);
    await expect(handler(req, res)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('grants a super-admin delete on a system-scoped skill (creator recovery)', async () => {
    mockFindById.mockResolvedValue(skillDoc({ userId: undefined, isSystem: true, users: [] }));
    const { req, res } = createMocks({ method: 'DELETE', query: { id: 'skill-1' } });
    (req as unknown as { user: unknown }).user = { id: 'admin-1', isAdmin: true };
    await handler(req, res);
    expect(mockDelete).toHaveBeenCalledWith('skill-1');
  });
});

describe('/api/skills/[id] GET — share-roster redaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the share roster to the owner', async () => {
    mockFindById.mockResolvedValue(skillDoc({ isGlobalRead: true }));
    const { req, res } = makeReqRes('GET', OWNER);
    await handler(req, res);
    const body = res._getJSONData();
    expect(body.users).toBeDefined();
    expect(body.users).toHaveLength(2);
  });

  it('redacts the roster for a global-read viewer (own row only, groups stripped)', async () => {
    mockFindById.mockResolvedValue(
      skillDoc({ isGlobalRead: true, groups: [{ groupId: 'g1', permissions: ['read'] }] })
    );
    const { req, res } = makeReqRes('GET', OUTSIDER);
    await handler(req, res);
    const body = res._getJSONData();
    expect(body.name).toBe('summarize'); // still returned
    expect(body.users).toEqual([]); // no other recipients leaked
    expect(body.groups).toBeUndefined(); // groups fully stripped
  });

  it("keeps the caller's own row so an edit-only recipient can still gate the Edit button", async () => {
    mockFindById.mockResolvedValue(skillDoc({ isGlobalRead: true }));
    const { req, res } = makeReqRes('GET', SHARED_UPDATE);
    await handler(req, res);
    const body = res._getJSONData();
    // Only their own row survives - not the other recipient's.
    expect(body.users).toEqual([{ userId: SHARED_UPDATE, permissions: ['update'] }]);
  });

  it('rejects a viewer with no access at all', async () => {
    mockFindById.mockResolvedValue(skillDoc({ isGlobalRead: false, users: [] }));
    const { req, res } = makeReqRes('GET', OUTSIDER);
    await expect(handler(req, res)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
