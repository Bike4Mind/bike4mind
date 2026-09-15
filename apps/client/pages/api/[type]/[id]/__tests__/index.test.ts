import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/[type]/[id] previously returned any invite's document name, owner username,
 * permissions and message to ANY authenticated caller holding the id -- the same defect
 * as GET /api/invites/[id], on the generic route. It must gate on the same population
 * accept/refuse redeem for: a named recipient, or a caller with share authority on the
 * underlying document. A caller who fails the gate gets a 404, not a 403 (a 403 would
 * confirm the id exists).
 */

const VALID_ID = '507f1f77bcf86cd799439011';

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

const findById = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database/social', () => ({ Invite: { findById } }));

const authorizeByInviteType = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', () => ({ sharingService: { authorizeByInviteType } }));
vi.mock('@bike4mind/database', () => ({
  fabFileRepository: {},
  sessionRepository: {},
  projectRepository: {},
  organizationRepository: {},
  Group: {},
  FabFile: {},
  Organization: {},
  Session: {},
  User: {},
}));

const getInviteDetails = vi.hoisted(() => vi.fn());
// Keep the real canViewInvite; stub only the DB-touching getInviteDetails.
vi.mock('@server/managers/inviteManager', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/managers/inviteManager')>();
  return { ...actual, getInviteDetails };
});

import '@pages/api/[type]/[id]/index';

describe('GET /api/[type]/[id] - authorization gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 (not 403) for a caller who is neither a recipient nor share-authorized', async () => {
    findById.mockResolvedValue({
      id: 'inv-1',
      type: 'FabFile',
      documentId: 'doc-1',
      recipients: { pending: ['other@x.com'], accepted: [], refused: [] },
    });
    authorizeByInviteType.mockRejectedValue(new Error('Unauthorized'));

    const { req, res } = createMocks({ method: 'GET', query: { type: 'files', id: VALID_ID } });
    (req as any).user = { id: 'u1', email: 'stranger@x.com' };
    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(404);
    expect(getInviteDetails).not.toHaveBeenCalled();
  });

  it('allows a named pending recipient', async () => {
    findById.mockResolvedValue({
      id: 'inv-1',
      type: 'FabFile',
      documentId: 'doc-1',
      recipients: { pending: ['me@x.com'], accepted: [], refused: [] },
    });
    getInviteDetails.mockResolvedValue({ id: 'inv-1', name: 'Doc' });

    const { req, res } = createMocks({ method: 'GET', query: { type: 'files', id: VALID_ID } });
    (req as any).user = { id: 'u1', email: 'me@x.com' };
    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(authorizeByInviteType).not.toHaveBeenCalled();
    expect(getInviteDetails).toHaveBeenCalled();
  });

  it('allows a caller with share authority on the underlying document even when not a named recipient', async () => {
    findById.mockResolvedValue({
      id: 'inv-1',
      type: 'FabFile',
      documentId: 'doc-1',
      recipients: { pending: ['other@x.com'], accepted: [], refused: [] },
    });
    authorizeByInviteType.mockResolvedValue(undefined);
    getInviteDetails.mockResolvedValue({ id: 'inv-1', name: 'Doc' });

    const { req, res } = createMocks({ method: 'GET', query: { type: 'files', id: VALID_ID } });
    (req as any).user = { id: 'owner-1', email: 'owner@x.com' };
    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(getInviteDetails).toHaveBeenCalled();
  });

  it('returns 404 when the invite does not exist', async () => {
    findById.mockResolvedValue(null);

    const { req, res } = createMocks({ method: 'GET', query: { type: 'files', id: VALID_ID } });
    (req as any).user = { id: 'u1', email: 'stranger@x.com' };
    await mockRefs.getHandler!(req, res);

    expect(res._getStatusCode()).toBe(404);
  });
});
