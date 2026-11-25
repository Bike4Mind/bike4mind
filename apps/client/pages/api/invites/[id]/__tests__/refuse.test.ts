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
const resolveAddressedInvite = vi.hoisted(() => vi.fn());
const flags = vi.hoisted(() => ({ spaces: true }));
vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({
  isFeatureEnabled: vi.fn(async (name: string) => (name === 'EnableSpaces' ? flags.spaces : false)),
}));
vi.mock('@bike4mind/services', () => ({ sharingService: { refuseWholeInvite, resolveAddressedInvite } }));
vi.mock('@bike4mind/database', () => ({
  spaceRepository: {},
  adminSettingsRepository: {},
  inviteRepository: {},
  fabFileRepository: {},
  sessionRepository: {},
  projectRepository: {},
  organizationRepository: {},
  Group: {},
}));
vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToClient }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'ws://test' } } }));
vi.mock('@server/credits/orgInviteBonus', () => ({ payOrgInviteBonus: vi.fn() }));

import '@pages/api/invites/[id]/refuse';

describe('POST /api/invites/[id]/refuse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flags.spaces = true;
  });

  it('answers 404 for a Space invite with EnableSpaces off, without refusing it', async () => {
    flags.spaces = false;
    resolveAddressedInvite.mockResolvedValue({ id: 'inv-1', type: 'Space' });
    const { req, res } = createMocks({ method: 'POST', query: { id: 'inv-1' }, body: {} });
    Object.assign(req, { user: { id: 'u1', email: 'u1@example.com' } });
    await expect(mockRefs.postHandler!(req, res)).rejects.toMatchObject({
      statusCode: 404,
      message: 'Invite not found',
    });
    expect(refuseWholeInvite).not.toHaveBeenCalled();
    expect(sendToClient).not.toHaveBeenCalled();
  });

  it('still refuses a non-Space invite with EnableSpaces off', async () => {
    flags.spaces = false;
    resolveAddressedInvite.mockResolvedValue({ id: 'inv-1', type: 'Project' });
    refuseWholeInvite.mockResolvedValue({ id: 'inv-1', remaining: 0 });
    const { req, res } = createMocks({ method: 'POST', query: { id: 'inv-1' }, body: {} });
    Object.assign(req, { user: { id: 'u1', email: 'u1@example.com' } });
    await mockRefs.postHandler!(req, res);

    expect(refuseWholeInvite).toHaveBeenCalledOnce();
  });

  it('refuses a Space invite as before with EnableSpaces on', async () => {
    refuseWholeInvite.mockResolvedValue({ id: 'inv-1', remaining: 0 });
    const { req, res } = createMocks({ method: 'POST', query: { id: 'inv-1' }, body: {} });
    Object.assign(req, { user: { id: 'u1', email: 'u1@example.com' } });
    await mockRefs.postHandler!(req, res);

    expect(resolveAddressedInvite).not.toHaveBeenCalled();
    expect(refuseWholeInvite).toHaveBeenCalledOnce();
  });

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

  it('strips co-recipients from the returned invite', async () => {
    refuseWholeInvite.mockResolvedValue({
      id: 'inv-1',
      recipients: { pending: [], accepted: ['other@x.com'], refused: ['me@x.com'] },
    });
    const { req, res } = createMocks({ method: 'POST', query: { id: 'inv-1' }, body: {} });
    (req as any).user = { id: 'u1', email: 'me@x.com' };
    await mockRefs.postHandler!(req, res);

    const body = res._getJSONData();
    expect(body.recipients.refused).toEqual(['me@x.com']);
    expect(JSON.stringify(body)).not.toContain('other@x.com');
  });
});
