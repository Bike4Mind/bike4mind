import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ForbiddenError, InviteType, NotFoundError } from '@bike4mind/common';

const refs = vi.hoisted(() => ({ handler: null as null | ((req: unknown, res: unknown) => unknown) }));
vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: () => chain,
    delete: (...fns: unknown[]) => {
      refs.handler = fns[fns.length - 1] as (req: unknown, res: unknown) => unknown;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));

const mocks = vi.hoisted(() => ({
  findOrganization: vi.fn(),
  assertCanManageOrgGroups: vi.fn(),
  findInvite: vi.fn(),
  markRevoked: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('@bike4mind/services', () => ({
  organizationService: { assertCanManageOrgGroups: mocks.assertCanManageOrgGroups },
}));
vi.mock('@bike4mind/database', () => ({
  organizationRepository: { findById: mocks.findOrganization },
  inviteRepository: { findById: mocks.findInvite, markRevoked: mocks.markRevoked },
}));
vi.mock('@server/managers/createDocumentInvite', () => ({
  generateInviteLink: (invite: { id: string; token?: string }) => `https://app.test/share/${invite.token ?? invite.id}`,
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest: mocks.audit }));

import '@pages/api/organizations/[id]/invite-links/[inviteId]';

const ORG_ID = '65a1f77bcf86cd7994390001';
const LINK = {
  id: 'link-1',
  token: 'tok-1',
  documentId: ORG_ID,
  type: InviteType.Organization,
  isLinkOnly: true,
  permissions: ['read'],
  remaining: 4,
  expiresAt: null,
  recipients: { pending: [], accepted: [], refused: [] },
};

const revoke = async (user: unknown = { id: 'u-owner' }) => {
  const { req, res } = createMocks({ method: 'DELETE', query: { id: ORG_ID, inviteId: 'link-1' } });
  (req as unknown as { user: unknown }).user = user;
  await refs.handler!(req, res);
  return res;
};

describe('DELETE /api/organizations/[id]/invite-links/[inviteId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findOrganization.mockResolvedValue({ id: ORG_ID, name: 'Acme', userId: 'u-owner', users: [] });
    mocks.assertCanManageOrgGroups.mockReturnValue(undefined);
  });

  it.each([
    ['another organization', { ...LINK, documentId: '65a1f77bcf86cd7994390099' }],
    ['a named organization invite', { ...LINK, isLinkOnly: false, recipients: { pending: ['a@example.com'] } }],
    ['a file share link', { ...LINK, type: InviteType.FabFile }],
    ['an unknown id', null],
  ])('404s %s without revoking', async (_label, invite) => {
    mocks.findInvite.mockResolvedValue(invite);
    await expect(revoke()).rejects.toBeInstanceOf(NotFoundError);
    expect(mocks.markRevoked).not.toHaveBeenCalled();
  });

  it('403s a member who cannot manage the organization', async () => {
    mocks.assertCanManageOrgGroups.mockImplementation(() => {
      throw new ForbiddenError('nope');
    });
    await expect(revoke()).rejects.toBeInstanceOf(ForbiddenError);
    expect(mocks.findInvite).not.toHaveBeenCalled();
  });

  it('revokes the link, audits it and returns the revoked view', async () => {
    const revokedAt = new Date();
    mocks.findInvite.mockResolvedValue(LINK);
    mocks.markRevoked.mockResolvedValue({ ...LINK, remaining: 0, revokedAt });

    const res = await revoke();

    expect(mocks.markRevoked).toHaveBeenCalledWith('link-1');
    expect(res._getJSONData()).toMatchObject({ id: 'link-1', remaining: 0, revokedAt: revokedAt.toISOString() });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'org.invite_link.revoked', details: { inviteId: 'link-1' } })
    );
  });

  it('lets a non-owner manager revoke an admin-role link without returning its URL', async () => {
    const adminLink = { ...LINK, permissions: ['read', 'update', 'share'] };
    mocks.findInvite.mockResolvedValue(adminLink);
    mocks.markRevoked.mockResolvedValue({ ...adminLink, remaining: 0, revokedAt: new Date() });

    mocks.findOrganization.mockResolvedValue({
      id: ORG_ID,
      name: 'Acme',
      userId: 'u-owner',
      users: [{ userId: 'u-manager', permissions: ['read'] }],
    });

    const res = await revoke({ id: 'u-manager' });

    expect(mocks.markRevoked).toHaveBeenCalledWith('link-1');
    expect(res._getJSONData()).toMatchObject({ id: 'link-1', link: null });
  });

  it('returns the URL of a revoked admin-role link to the owner', async () => {
    const adminLink = { ...LINK, permissions: ['read', 'update', 'share'] };
    mocks.findInvite.mockResolvedValue(adminLink);
    mocks.markRevoked.mockResolvedValue({ ...adminLink, remaining: 0, revokedAt: new Date() });

    const res = await revoke();

    expect(res._getJSONData()).toMatchObject({ id: 'link-1', link: 'https://app.test/share/tok-1' });
  });
});
