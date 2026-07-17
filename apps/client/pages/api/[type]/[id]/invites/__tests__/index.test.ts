import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/[type]/[id]/invites delegates listing to sharingService.listInvitesForDocument
 * (share-scoped auth lives in the service). These assert the delegation + arg shape,
 * the raw-array response, and the type/id guards.
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

const listInvitesForDocument = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', () => ({
  sharingService: { listInvitesForDocument, createInvite: vi.fn(), cancelInvite: vi.fn() },
}));

vi.mock('@bike4mind/database', () => ({
  FabFile: {},
  Group: {},
  Session: {},
  Project: {},
  Organization: {},
  withTransaction: (fn: any) => fn(),
  fabFileRepository: {},
  sessionRepository: {},
  userRepository: {},
  organizationRepository: {},
  projectRepository: {},
  inviteRepository: {},
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish: vi.fn() } } }));

import '@pages/api/[type]/[id]/invites/index';

describe('GET /api/[type]/[id]/invites', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates to listInvitesForDocument with the mapped invite type and returns the raw array', async () => {
    const invites = [{ id: 'i1', type: 'FabFile' }];
    listInvitesForDocument.mockResolvedValue(invites);
    const { req, res } = createMocks({ method: 'GET', query: { type: 'files', id: 'doc-1' } });
    (req as any).user = { id: 'u1' };
    await mockRefs.getHandler!(req, res);

    expect(listInvitesForDocument).toHaveBeenCalledWith(
      req.user,
      { documentId: 'doc-1', type: 'FabFile' },
      expect.objectContaining({ db: expect.any(Object) })
    );
    expect(res._getJSONData()).toEqual(invites);
  });

  it('returns 400 for an unrecognized type without calling the service', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { type: 'bogus', id: 'doc-1' } });
    (req as any).user = { id: 'u1' };
    await mockRefs.getHandler!(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(listInvitesForDocument).not.toHaveBeenCalled();
  });

  it('returns 400 when id is missing', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { type: 'files' } });
    (req as any).user = { id: 'u1' };
    await mockRefs.getHandler!(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(listInvitesForDocument).not.toHaveBeenCalled();
  });
});
