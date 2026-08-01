import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/[type]/[id]/invites delegates listing to sharingService.listInvitesForDocument
 * (share-scoped auth lives in the service). These assert the delegation + arg shape,
 * the raw-array response, and the type/id guards.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  deleteHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    post: () => chain,
    delete: (fn: any) => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const listInvitesForDocument = vi.hoisted(() => vi.fn());
const cancelInvite = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', () => ({
  sharingService: { listInvitesForDocument, createInvite: vi.fn(), cancelInvite },
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

/**
 * DELETE cancels every open invite for a document, so which document it targets is the whole
 * question. Two properties are pinned here because both are invisible at the service layer:
 * the request body cannot redirect the call away from the URL's document, and this route's
 * :type segment carries the InviteType value itself rather than the alias GET/POST use.
 */
describe('DELETE /api/[type]/[id]/invites', () => {
  beforeEach(() => vi.clearAllMocks());

  it('takes type and id from the path and ignores conflicting body values', async () => {
    cancelInvite.mockResolvedValue([{ id: 'i1', documentId: 'doc-1', type: 'Project' }]);
    const { req, res } = createMocks({
      method: 'DELETE',
      query: { type: 'Project', id: 'doc-1' },
      body: { type: 'Organization', id: 'victim-doc', email: 'a@b.test' },
    });
    (req as any).user = { id: 'u1' };

    await mockRefs.deleteHandler!(req, res);

    expect(cancelInvite).toHaveBeenCalledWith(
      req.user,
      { type: 'Project', id: 'doc-1', email: 'a@b.test' },
      expect.objectContaining({ db: expect.any(Object) })
    );
  });

  it('passes the raw InviteType from the path, not a URL alias', async () => {
    // Guards against "harmonizing" this handler with GET/POST via URL_PATH_TO_INVITE_TYPE:
    // 'Organization' is not a key of that map, so every cancel in the product would break.
    cancelInvite.mockResolvedValue([{ id: 'i1', documentId: 'org-1', type: 'Organization' }]);
    const { req, res } = createMocks({
      method: 'DELETE',
      query: { type: 'Organization', id: 'org-1' },
      body: { email: 'a@b.test' },
    });
    (req as any).user = { id: 'u1' };

    await mockRefs.deleteHandler!(req, res);

    expect(cancelInvite).toHaveBeenCalledWith(
      req.user,
      { type: 'Organization', id: 'org-1', email: 'a@b.test' },
      expect.anything()
    );
  });

  it('rejects a path missing type or id without calling the service', async () => {
    const { req, res } = createMocks({ method: 'DELETE', query: { type: 'Project' }, body: {} });
    (req as any).user = { id: 'u1' };

    // This handler throws for the central errorHandler to map (400), rather than writing the
    // status itself the way the GET handler above does - hence rejects, not _getStatusCode.
    await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow('Invalid cancel invite request');
    expect(cancelInvite).not.toHaveBeenCalled();
  });
});
