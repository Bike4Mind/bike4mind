import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/[type]/[id]/invites delegates listing to sharingService.listInvitesForDocument
 * (share-scoped auth lives in the service). These assert the delegation + arg shape,
 * the raw-array response, and the type/id guards.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  postHandler: null as null | ((req: any, res: any) => unknown),
  deleteHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
    delete: (fn: any) => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const listInvitesForDocument = vi.hoisted(() => vi.fn());
const cancelInvite = vi.hoisted(() => vi.fn());
const createInvite = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', () => ({
  sharingService: { listInvitesForDocument, createInvite, cancelInvite },
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

  it('accepts the raw InviteType in the path as well as the alias', async () => {
    listInvitesForDocument.mockResolvedValue([]);
    const { req, res } = createMocks({ method: 'GET', query: { type: 'FabFile', id: 'doc-1' } });
    (req as any).user = { id: 'u1' };
    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(listInvitesForDocument).toHaveBeenCalledWith(
      req.user,
      { documentId: 'doc-1', type: 'FabFile' },
      expect.anything()
    );
  });
});

/**
 * Both :type vocabularies address the same document on POST: the lowercase alias the client's
 * shareDocument sends, and the InviteType value itself.
 */
describe('POST /api/[type]/[id]/invites', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createInvite.mockResolvedValue({ id: 'i1', recipients: { pending: [] } });
  });

  it.each([
    ['alias', 'files'],
    ['raw InviteType', 'FabFile'],
  ])('accepts the %s form and creates against FabFile', async (_label: string, pathType: string) => {
    const { req, res } = createMocks({
      method: 'POST',
      query: { type: pathType, id: 'doc-1' },
      body: { permissions: ['Read'] },
    });
    (req as any).user = { id: 'u1' };

    await mockRefs.postHandler!(req, res);

    expect(createInvite).toHaveBeenCalledWith(
      req.user,
      expect.objectContaining({ id: 'doc-1', type: 'FabFile' }),
      expect.anything()
    );
  });

  it('rejects an unrecognized type without calling the service', async () => {
    const { req, res } = createMocks({ method: 'POST', query: { type: 'bogus', id: 'doc-1' }, body: {} });
    (req as any).user = { id: 'u1' };

    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow('Invalid type');
    expect(createInvite).not.toHaveBeenCalled();
  });
});

/**
 * DELETE cancels every open invite for a document, so which document it targets is the whole
 * question. Two properties are pinned here because both are invisible at the service layer:
 * the request body cannot redirect the call away from the URL's document, and the :type segment
 * accepts the InviteType value itself as well as the lowercase alias.
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
    // Guards against resolving this segment through the alias map alone: 'Organization' is not a
    // key of that map, so every cancel in the product would break.
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

  it('also accepts the lowercase alias GET/POST use', async () => {
    cancelInvite.mockResolvedValue([{ id: 'i1', documentId: 'org-1', type: 'Organization' }]);
    const { req, res } = createMocks({
      method: 'DELETE',
      query: { type: 'organizations', id: 'org-1' },
      body: {},
    });
    (req as any).user = { id: 'u1' };

    await mockRefs.deleteHandler!(req, res);

    expect(cancelInvite).toHaveBeenCalledWith(
      req.user,
      { type: 'Organization', id: 'org-1', email: undefined },
      expect.anything()
    );
  });

  it('rejects an unrecognized type without calling the service', async () => {
    const { req, res } = createMocks({ method: 'DELETE', query: { type: 'bogus', id: 'doc-1' }, body: {} });
    (req as any).user = { id: 'u1' };

    await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow('Invalid cancel invite request');
    expect(cancelInvite).not.toHaveBeenCalled();
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
