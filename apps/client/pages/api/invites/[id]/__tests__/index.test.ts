import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * DELETE /api/invites/[id] delegates to sharingService.cancelInviteById (share-scoped
 * auth lives in the service). Asserts delegation + the id guard.
 */

const mockRefs = vi.hoisted(() => ({
  deleteHandler: null as null | ((req: any, res: any) => unknown),
  getHandler: null as null | ((req: any, res: any) => unknown),
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

const cancelInviteById = vi.hoisted(() => vi.fn());
const authorizeByInviteType = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', () => ({ sharingService: { cancelInviteById, authorizeByInviteType } }));
vi.mock('@bike4mind/database', () => ({
  Invite: { findById: vi.fn() },
  inviteRepository: {},
  fabFileRepository: {},
  sessionRepository: {},
  projectRepository: {},
  organizationRepository: {},
  Group: {},
}));
const getInviteDetails = vi.hoisted(() => vi.fn());
// Keep the real filterInviteRecipientsToSelf; stub only the DB-touching getInviteDetails.
vi.mock('@server/managers/inviteManager', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/managers/inviteManager')>();
  return { ...actual, getInviteDetails };
});

import { Invite } from '@bike4mind/database';
import '@pages/api/invites/[id]/index';

// GET validates the id shape before findById (matching pages/api/[type]/[id]), so the fixture
// id has to be ObjectId-shaped or the handler answers 400 before any of this is exercised.
const VALID_INVITE_ID = '507f1f77bcf86cd799439011';

describe('DELETE /api/invites/[id]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates to cancelInviteById with the invite id and returns the result', async () => {
    cancelInviteById.mockResolvedValue({ id: 'inv-1', remaining: 0 });
    const { req, res } = createMocks({ method: 'DELETE', query: { id: 'inv-1' } });
    (req as any).user = { id: 'u1' };
    await mockRefs.deleteHandler!(req, res);

    expect(cancelInviteById).toHaveBeenCalledWith(
      req.user,
      { id: 'inv-1' },
      expect.objectContaining({ db: expect.any(Object) })
    );
    expect(res._getJSONData()).toEqual({ id: 'inv-1', remaining: 0 });
  });

  it('returns 400 when id is missing', async () => {
    const { req, res } = createMocks({ method: 'DELETE', query: {} });
    (req as any).user = { id: 'u1' };
    await mockRefs.deleteHandler!(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(cancelInviteById).not.toHaveBeenCalled();
  });
});

describe('GET /api/invites/[id] - recipient email strip', () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps only the caller's own recipient entry, dropping co-invitees", async () => {
    (Invite.findById as any).mockResolvedValue({
      id: 'inv-1',
      type: 'FabFile',
      documentId: 'doc-1',
      recipients: { pending: ['me@x.com'], accepted: [], refused: [] },
    });
    getInviteDetails.mockResolvedValue({
      id: 'inv-1',
      type: 'FabFile',
      name: 'Doc',
      username: 'inviter',
      recipients: { pending: ['me@x.com', 'other@x.com'], accepted: ['third@x.com'], refused: [] },
    });
    const { req, res } = createMocks({ method: 'GET', query: { id: VALID_INVITE_ID } });
    (req as any).user = { id: 'u1', email: 'me@x.com' };
    await mockRefs.getHandler!(req, res);

    const body = res._getJSONData();
    expect(body.type).toBe('FabFile');
    expect(body.recipients.pending).toEqual(['me@x.com']);
    expect(JSON.stringify(body)).not.toContain('other@x.com');
    expect(JSON.stringify(body)).not.toContain('third@x.com');
  });
});

/**
 * The GET handler previously returned any invite's document name, owner username,
 * permissions and message to ANY authenticated caller holding the id. It must now gate
 * on the same population accept/refuse redeem for: a named recipient, or a caller with
 * share authority on the underlying document.
 */
describe('GET /api/invites/[id] - authorization gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a malformed invite id before it reaches findById', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { id: 'not-an-object-id' } });
    (req as any).user = { id: 'u1', email: 'a@x.com' };
    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(Invite.findById).not.toHaveBeenCalled();
  });

  it('returns 404 (not 403) for a caller who is neither a recipient nor share-authorized', async () => {
    (Invite.findById as any).mockResolvedValue({
      id: 'inv-1',
      type: 'FabFile',
      documentId: 'doc-1',
      recipients: { pending: ['other@x.com'], accepted: [], refused: [] },
    });
    authorizeByInviteType.mockRejectedValue(new Error('Unauthorized'));

    const { req, res } = createMocks({ method: 'GET', query: { id: VALID_INVITE_ID } });
    (req as any).user = { id: 'u1', email: 'stranger@x.com' };
    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(404);
    expect(getInviteDetails).not.toHaveBeenCalled();
  });

  it('allows a caller with share authority on the underlying document even when not a named recipient', async () => {
    (Invite.findById as any).mockResolvedValue({
      id: 'inv-1',
      type: 'FabFile',
      documentId: 'doc-1',
      recipients: { pending: ['other@x.com'], accepted: [], refused: [] },
    });
    authorizeByInviteType.mockResolvedValue(undefined);
    getInviteDetails.mockResolvedValue({
      id: 'inv-1',
      type: 'FabFile',
      recipients: { pending: ['other@x.com'], accepted: [], refused: [] },
    });

    const { req, res } = createMocks({ method: 'GET', query: { id: VALID_INVITE_ID } });
    (req as any).user = { id: 'owner-1', email: 'owner@x.com' };
    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(getInviteDetails).toHaveBeenCalled();
  });
});
