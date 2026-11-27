import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/invites delegates to sharingService.listOwnPendingInvites and unwraps
 * the { data, total } envelope to the raw array (preserving the external wire shape).
 */

const mockRefs = vi.hoisted(() => ({ getHandler: null as null | ((req: any, res: any) => unknown) }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    post: () => chain,
    delete: () => chain,
  };
  return { baseApi: () => chain };
});

const listOwnPendingInvites = vi.hoisted(() => vi.fn());
const flags = vi.hoisted(() => ({ spaces: true }));
vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({
  isFeatureEnabled: vi.fn(async (name: string) => (name === 'EnableSpaces' ? flags.spaces : false)),
}));
vi.mock('@bike4mind/services', () => ({ sharingService: { listOwnPendingInvites } }));
vi.mock('@bike4mind/database', () => ({ inviteRepository: {} }));

import '@pages/api/invites/index';

describe('GET /api/invites', () => {
  beforeEach(() => vi.clearAllMocks());

  it('hides Space invites with EnableSpaces off and keeps the others', async () => {
    flags.spaces = false;
    listOwnPendingInvites.mockResolvedValue({
      data: [
        { id: 's1', type: 'Space', recipients: { pending: ['me@x.com'], accepted: [], refused: [] } },
        { id: 'p1', type: 'Project', recipients: { pending: ['me@x.com'], accepted: [], refused: [] } },
      ],
      total: 2,
    });
    const { req, res } = createMocks({ method: 'GET', query: { id: 'me' } });
    Object.assign(req, { user: { id: 'me', email: 'me@x.com', isAdmin: false } });
    await mockRefs.getHandler!(req, res);

    const body = res._getJSONData();
    const rows = Array.isArray(body) ? body : body.data;
    expect(rows.map((row: { id: string }) => row.id)).toEqual(['p1']);
  });

  it('returns Space invites unchanged with EnableSpaces on', async () => {
    flags.spaces = true;
    listOwnPendingInvites.mockResolvedValue({
      data: [{ id: 's1', type: 'Space', recipients: { pending: ['me@x.com'], accepted: [], refused: [] } }],
      total: 1,
    });
    const { req, res } = createMocks({ method: 'GET', query: { id: 'me' } });
    Object.assign(req, { user: { id: 'me', email: 'me@x.com', isAdmin: false } });
    await mockRefs.getHandler!(req, res);

    const body = res._getJSONData();
    const rows = Array.isArray(body) ? body : body.data;
    expect(rows.map((row: { id: string }) => row.id)).toEqual(['s1']);
  });

  it('calls listOwnPendingInvites with {limit,page} and returns the unwrapped data array', async () => {
    listOwnPendingInvites.mockResolvedValue({ data: [{ id: 'i1' }], total: 1 });
    const { req, res } = createMocks({ method: 'GET', query: { limit: '5', page: '2' } });
    (req as any).user = { id: 'u1', email: 'u1@example.com' };
    await mockRefs.getHandler!(req, res);

    expect(listOwnPendingInvites).toHaveBeenCalledWith(
      req.user,
      { limit: 5, page: 2 },
      expect.objectContaining({ db: expect.any(Object) })
    );
    expect(res._getJSONData()).toEqual([{ id: 'i1' }]);
  });

  it('defaults to returning all pending invites (limit 1000) when pagination is not supplied', async () => {
    listOwnPendingInvites.mockResolvedValue({ data: [], total: 0 });
    const { req, res } = createMocks({ method: 'GET', query: {} });
    (req as any).user = { id: 'u1' };
    await mockRefs.getHandler!(req, res);
    expect(listOwnPendingInvites).toHaveBeenCalledWith(req.user, { limit: 1000, page: 1 }, expect.any(Object));
  });

  it("strips co-recipients from each invite, keeping the caller's own entry", async () => {
    listOwnPendingInvites.mockResolvedValue({
      data: [{ id: 'i1', recipients: { pending: ['me@x.com', 'other@x.com'], accepted: [], refused: [] } }],
      total: 1,
    });
    const { req, res } = createMocks({ method: 'GET', query: {} });
    (req as any).user = { id: 'u1', email: 'me@x.com' };
    await mockRefs.getHandler!(req, res);

    const body = res._getJSONData();
    expect(body[0].recipients.pending).toEqual(['me@x.com']); // self-check preserved
    expect(JSON.stringify(body)).not.toContain('other@x.com');
  });
});
