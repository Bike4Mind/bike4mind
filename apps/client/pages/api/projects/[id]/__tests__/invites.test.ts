import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  postHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const createInvite = vi.hoisted(() => vi.fn());
const listInvites = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', () => ({
  sharingService: { createInvite },
  projectService: { listInvites },
}));

vi.mock('@bike4mind/database', () => ({
  projectRepository: {},
  inviteRepository: {},
  userRepository: {},
  fabFileRepository: {},
  sessionRepository: {},
  organizationRepository: {},
  withTransaction: (fn: any) => fn(),
  // Return null so the ADD_MEMBER logEvent block is skipped for tests with empty pending.
  Project: { findById: () => Promise.resolve(null) },
  Group: {},
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

import '@pages/api/projects/[id]/invites';

/**
 * POST /api/projects/:id/invites security property: the path id is authoritative.
 * Before this PR, spreading req.body as any after `id` let a caller pass {"id":"<other>"}
 * to mint a share link for a different project. The schema parse strips unknown keys,
 * so only the query param id reaches the service.
 */
describe('POST /api/projects/:id/invites', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createInvite.mockResolvedValue({ id: 'inv-1', recipients: { pending: [] } });
  });

  it('does not allow a body id to redirect the invite to a different project', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      query: { id: 'proj-path-id' },
      body: { permissions: ['read'], id: 'attacker-proj-id' },
    });
    (req as any).user = { id: 'u1' };

    await mockRefs.postHandler!(req, res);

    expect(createInvite).toHaveBeenCalledWith(
      req.user,
      expect.objectContaining({ id: 'proj-path-id', type: 'Project' }),
      expect.anything()
    );
    expect(createInvite).not.toHaveBeenCalledWith(
      req.user,
      expect.objectContaining({ id: 'attacker-proj-id' }),
      expect.anything()
    );
  });

  it('creates the invite for the path project id', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      query: { id: 'proj-1' },
      body: { permissions: ['read'] },
    });
    (req as any).user = { id: 'u1' };

    await mockRefs.postHandler!(req, res);

    expect(createInvite).toHaveBeenCalledWith(
      req.user,
      expect.objectContaining({ id: 'proj-1', type: 'Project' }),
      expect.anything()
    );
  });

  it('returns 400 when id is missing from the path', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      query: {},
      body: { permissions: ['read'] },
    });
    (req as any).user = { id: 'u1' };

    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(createInvite).not.toHaveBeenCalled();
  });

  it('accepts a future ISO expiresAt and coerces it to Date', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      query: { id: 'proj-1' },
      body: { permissions: ['read'], expiresAt: '2099-12-31T00:00:00.000Z' },
    });
    (req as any).user = { id: 'u1' };
    await mockRefs.postHandler!(req, res);
    expect(createInvite).toHaveBeenCalledWith(
      req.user,
      expect.objectContaining({ expiresAt: expect.any(Date) }),
      expect.anything()
    );
  });

  it('maps null expiresAt to undefined so the service prefault applies', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      query: { id: 'proj-1' },
      body: { permissions: ['read'], expiresAt: null },
    });
    (req as any).user = { id: 'u1' };
    await mockRefs.postHandler!(req, res);
    expect(createInvite).not.toHaveBeenCalledWith(
      req.user,
      expect.objectContaining({ expiresAt: expect.anything() }),
      expect.anything()
    );
  });

  it('rejects a past expiresAt without calling the service', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      query: { id: 'proj-1' },
      body: { permissions: ['read'], expiresAt: '2020-01-01T00:00:00.000Z' },
    });
    (req as any).user = { id: 'u1' };
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow();
    expect(createInvite).not.toHaveBeenCalled();
  });

  it('rejects a missing permissions field without calling the service', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      query: { id: 'proj-1' },
      body: {},
    });
    (req as any).user = { id: 'u1' };
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow();
    expect(createInvite).not.toHaveBeenCalled();
  });
});
