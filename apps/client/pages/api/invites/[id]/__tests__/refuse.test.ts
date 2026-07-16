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
vi.mock('@bike4mind/services', () => ({ sharingService: { refuseWholeInvite } }));
vi.mock('@bike4mind/database', () => ({ inviteRepository: {}, userRepository: {} }));
vi.mock('@server/websocket/utils', () => ({ sendToClient: vi.fn().mockResolvedValue(undefined) }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'ws://test' } } }));

import '@pages/api/invites/[id]/refuse';

describe('POST /api/invites/[id]/refuse', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates to refuseWholeInvite with the caller id + isPublic flag', async () => {
    refuseWholeInvite.mockResolvedValue({ id: 'inv-1', remaining: 0 });
    const { req, res } = createMocks({ method: 'POST', query: { id: 'inv-1' }, body: { public: true } });
    (req as any).user = { id: 'u1' };
    await mockRefs.postHandler!(req, res);

    expect(refuseWholeInvite).toHaveBeenCalledWith(
      'u1',
      { id: 'inv-1', isPublic: true },
      expect.objectContaining({ db: expect.any(Object) })
    );
    expect(res._getJSONData()).toEqual({ id: 'inv-1', remaining: 0 });
  });

  it('returns 400 when id is missing', async () => {
    const { req, res } = createMocks({ method: 'POST', query: {}, body: {} });
    (req as any).user = { id: 'u1' };
    await mockRefs.postHandler!(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(refuseWholeInvite).not.toHaveBeenCalled();
  });
});
