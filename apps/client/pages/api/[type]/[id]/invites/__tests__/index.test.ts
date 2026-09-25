import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/[type]/[id]/invites delegates listing to sharingService.listInvitesForDocument
 * (share-scoped auth lives in the service). These assert the delegation + arg shape,
 * the raw-array response, and the type/id guards.
 */

const TOKEN = 'wVvJ0hEr1sKq7nQ9YpB2fL4dXz8TcMuGaSiN3ROZjkw';

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
    const { req, res } = createMocks({ method: 'GET', query: { type: 'files', id: '507f1f77bcf86cd799439011' } });
    (req as any).user = { id: 'u1' };
    await mockRefs.getHandler!(req, res);

    expect(listInvitesForDocument).toHaveBeenCalledWith(
      req.user,
      { documentId: '507f1f77bcf86cd799439011', type: 'FabFile' },
      expect.objectContaining({ db: expect.any(Object) })
    );
    expect(res._getJSONData()).toEqual(invites);
  });

  it('returns 400 for an unrecognized type without calling the service', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { type: 'bogus', id: '507f1f77bcf86cd799439011' } });
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
    const { req, res } = createMocks({ method: 'GET', query: { type: 'FabFile', id: '507f1f77bcf86cd799439011' } });
    (req as any).user = { id: 'u1' };
    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(listInvitesForDocument).toHaveBeenCalledWith(
      req.user,
      { documentId: '507f1f77bcf86cd799439011', type: 'FabFile' },
      expect.anything()
    );
  });

  // The list is share-authorized, so this is not an authorization hole - it is a redeemable secret
  // with no consumer on this surface, re-readable from any cache of the response.
  it('strips every bearer token from the listed invites', async () => {
    listInvitesForDocument.mockResolvedValue([
      { id: 'i1', type: 'FabFile', token: TOKEN },
      { id: 'i2', type: 'FabFile' },
    ]);
    const { req, res } = createMocks({ method: 'GET', query: { type: 'files', id: '507f1f77bcf86cd799439011' } });
    (req as any).user = { id: 'u1' };
    await mockRefs.getHandler!(req, res);

    expect(JSON.stringify(res._getJSONData())).not.toContain(TOKEN);
    expect(res._getJSONData()).toEqual([
      { id: 'i1', type: 'FabFile' },
      { id: 'i2', type: 'FabFile' },
    ]);
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

  // The `link` is the one place the token belongs, and it is what the client reads. Echoing the bare
  // field alongside it puts the same secret in a second, unadvertised place in the body.
  it('returns the token inside the share link and nowhere else', async () => {
    createInvite.mockResolvedValue({ id: 'i1', token: TOKEN, recipients: { pending: [] } });
    const { req, res } = createMocks({
      method: 'POST',
      query: { type: 'files', id: '507f1f77bcf86cd799439011' },
      body: { permissions: ['read'] },
    });
    (req as any).user = { id: 'u1' };

    await mockRefs.postHandler!(req, res);

    const body = res._getJSONData();
    expect(body.link).toContain(TOKEN);
    expect('token' in body).toBe(false);
  });

  it.each([
    ['alias', 'files'],
    ['raw InviteType', 'FabFile'],
  ])('accepts the %s form and creates against FabFile', async (_label: string, pathType: string) => {
    const { req, res } = createMocks({
      method: 'POST',
      query: { type: pathType, id: '507f1f77bcf86cd799439011' },
      body: { permissions: ['read'] },
    });
    (req as any).user = { id: 'u1' };

    await mockRefs.postHandler!(req, res);

    expect(createInvite).toHaveBeenCalledWith(
      req.user,
      expect.objectContaining({ id: '507f1f77bcf86cd799439011', type: 'FabFile' }),
      expect.anything()
    );
  });

  it('does not allow a body id to redirect the invite to a different document', async () => {
    // Security property: body spread used to win over the path param. Verify the path param is authoritative.
    const { req, res } = createMocks({
      method: 'POST',
      query: { type: 'files', id: '507f1f77bcf86cd799439013' },
      body: { permissions: ['read'], id: '507f1f77bcf86cd799439014' },
    });
    (req as any).user = { id: 'u1' };
    await mockRefs.postHandler!(req, res);
    expect(createInvite).toHaveBeenCalledWith(
      req.user,
      expect.objectContaining({ id: '507f1f77bcf86cd799439013', type: 'FabFile' }),
      expect.anything()
    );
    expect(createInvite).not.toHaveBeenCalledWith(
      req.user,
      expect.objectContaining({ id: '507f1f77bcf86cd799439014' }),
      expect.anything()
    );
  });

  it('accepts a future ISO expiresAt and coerces it to Date', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      query: { type: 'files', id: '507f1f77bcf86cd799439011' },
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
      query: { type: 'files', id: '507f1f77bcf86cd799439011' },
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
      query: { type: 'files', id: '507f1f77bcf86cd799439011' },
      body: { permissions: ['read'], expiresAt: '2020-01-01T00:00:00.000Z' },
    });
    (req as any).user = { id: 'u1' };
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow();
    expect(createInvite).not.toHaveBeenCalled();
  });

  it('rejects a missing permissions field without calling the service', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      query: { type: 'files', id: '507f1f77bcf86cd799439011' },
      body: {},
    });
    (req as any).user = { id: 'u1' };
    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow();
    expect(createInvite).not.toHaveBeenCalled();
  });

  it('rejects an unrecognized type without calling the service', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      query: { type: 'bogus', id: '507f1f77bcf86cd799439011' },
      body: {},
    });
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
    cancelInvite.mockResolvedValue([{ id: 'i1', documentId: '507f1f77bcf86cd799439011', type: 'Project' }]);
    const { req, res } = createMocks({
      method: 'DELETE',
      query: { type: 'Project', id: '507f1f77bcf86cd799439011' },
      body: { type: 'Organization', id: 'victim-doc', email: 'a@b.test' },
    });
    (req as any).user = { id: 'u1' };

    await mockRefs.deleteHandler!(req, res);

    expect(cancelInvite).toHaveBeenCalledWith(
      req.user,
      { type: 'Project', id: '507f1f77bcf86cd799439011', email: 'a@b.test' },
      expect.objectContaining({ db: expect.any(Object) })
    );
  });

  it('passes the raw InviteType from the path, not a URL alias', async () => {
    // Guards against resolving this segment through the alias map alone: 'Organization' is not a
    // key of that map, so every cancel in the product would break.
    cancelInvite.mockResolvedValue([{ id: 'i1', documentId: '507f1f77bcf86cd799439015', type: 'Organization' }]);
    const { req, res } = createMocks({
      method: 'DELETE',
      query: { type: 'Organization', id: '507f1f77bcf86cd799439015' },
      body: { email: 'a@b.test' },
    });
    (req as any).user = { id: 'u1' };

    await mockRefs.deleteHandler!(req, res);

    expect(cancelInvite).toHaveBeenCalledWith(
      req.user,
      { type: 'Organization', id: '507f1f77bcf86cd799439015', email: 'a@b.test' },
      expect.anything()
    );
  });

  it('also accepts the lowercase alias GET/POST use', async () => {
    cancelInvite.mockResolvedValue([{ id: 'i1', documentId: '507f1f77bcf86cd799439015', type: 'Organization' }]);
    const { req, res } = createMocks({
      method: 'DELETE',
      query: { type: 'organizations', id: '507f1f77bcf86cd799439015' },
      body: {},
    });
    (req as any).user = { id: 'u1' };

    await mockRefs.deleteHandler!(req, res);

    expect(cancelInvite).toHaveBeenCalledWith(
      req.user,
      { type: 'Organization', id: '507f1f77bcf86cd799439015', email: undefined },
      expect.anything()
    );
  });

  it.each([
    ['an unrecognized type', { type: 'bogus', id: '507f1f77bcf86cd799439011' }],
    // An inherited Object.prototype key must not resolve through the alias map.
    ['an inherited alias-map key', { type: 'constructor', id: '507f1f77bcf86cd799439011' }],
    ['a missing id', { type: 'Project' }],
    ['a missing type', { id: '507f1f77bcf86cd799439011' }],
  ])('rejects %s without calling the service', async (_label: string, query: Record<string, string>) => {
    const { req, res } = createMocks({ method: 'DELETE', query, body: {} });
    (req as any).user = { id: 'u1' };

    // This handler throws for the central errorHandler to map (400), rather than writing the
    // status itself the way the GET handler above does - hence rejects, not _getStatusCode.
    await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow('Invalid cancel invite request');
    expect(cancelInvite).not.toHaveBeenCalled();
  });
});
