import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * POST /api/invites/[id]/refuse delegates to sharingService.refuseWholeInvite
 * (recipient auth lives in the service). Asserts delegation + the id guard.
 */

const mockRefs = vi.hoisted(() => ({ postHandler: null as null | ((req: any, res: any) => unknown) }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: () => chain,
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
    delete: () => chain,
  };
  return { baseApi: () => chain };
});

const refuseWholeInvite = vi.hoisted(() => vi.fn());
const sendToClient = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@bike4mind/services', () => ({ sharingService: { refuseWholeInvite } }));
vi.mock('@bike4mind/database', () => ({ inviteRepository: {} }));
vi.mock('@server/websocket/utils', () => ({ sendToClient }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'ws://test' } } }));

import '@pages/api/invites/[id]/refuse';

describe('POST /api/invites/[id]/refuse', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates to refuseWholeInvite with the caller doc (no client public flag) and fires the WS refetch', async () => {
    refuseWholeInvite.mockResolvedValue({ id: 'inv-1', remaining: 0 });
    // a `public: true` body is ignored - the route no longer forwards it
    const { req, res } = createMocks({ method: 'POST', query: { id: 'inv-1' }, body: { public: true } });
    (req as any).user = { id: 'u1', email: 'u1@example.com' };
    await mockRefs.postHandler!(req, res);

    expect(refuseWholeInvite).toHaveBeenCalledWith(
      req.user,
      { id: 'inv-1' },
      expect.objectContaining({ db: expect.any(Object) })
    );
    expect(sendToClient).toHaveBeenCalledOnce();
    expect(res._getJSONData()).toEqual({ id: 'inv-1', remaining: 0 });
  });

  it('returns 404 without firing the WS event when the invite is gone', async () => {
    refuseWholeInvite.mockResolvedValue(null);
    const { req, res } = createMocks({ method: 'POST', query: { id: 'inv-1' }, body: {} });
    (req as any).user = { id: 'u1' };
    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(404);
    expect(sendToClient).not.toHaveBeenCalled();
  });

  it('returns 400 when id is missing', async () => {
    const { req, res } = createMocks({ method: 'POST', query: {}, body: {} });
    (req as any).user = { id: 'u1' };
    await mockRefs.postHandler!(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(refuseWholeInvite).not.toHaveBeenCalled();
  });
});
