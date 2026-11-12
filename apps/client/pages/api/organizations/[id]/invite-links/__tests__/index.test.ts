import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { BadRequestError, ForbiddenError, InviteType, NotFoundError } from '@bike4mind/common';

const refs = vi.hoisted(() => ({ handlers: {} as Record<string, (req: unknown, res: unknown) => unknown> }));
vi.mock('@server/auth/assertOutboundActionAllowed', () => ({ outboundActionGate: () => Symbol('gate') }));
vi.mock('@server/middlewares/baseApi', () => {
  type Chain = Record<'use' | 'get' | 'post' | 'delete', (...fns: unknown[]) => Chain>;
  const chain = {} as Chain;
  for (const method of ['get', 'post', 'delete'] as const) {
    chain[method] = (...fns) => {
      refs.handlers[method] = fns[fns.length - 1] as (req: unknown, res: unknown) => unknown;
      return chain;
    };
  }
  chain.use = () => chain;
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));

const mocks = vi.hoisted(() => ({
  findOrganization: vi.fn(),
  assertCanManageOrgGroups: vi.fn(),
  findInvites: vi.fn(),
  createDocumentInvite: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('@bike4mind/services', async () => {
  const { HOSTNAME_PATTERN, MAX_ORG_LINK_AVAILABLE, MAX_INVITE_ALLOWED_DOMAINS } =
    await import('../../../../../../../../b4m-core/services/src/sharingService/create');
  return {
    sharingService: { HOSTNAME_PATTERN, MAX_ORG_LINK_AVAILABLE, MAX_INVITE_ALLOWED_DOMAINS },
    organizationService: { assertCanManageOrgGroups: mocks.assertCanManageOrgGroups },
  };
});
vi.mock('@bike4mind/database', () => ({
  organizationRepository: { findById: mocks.findOrganization },
  inviteRepository: { findAllByDocumentId: mocks.findInvites },
}));
vi.mock('@server/managers/createDocumentInvite', () => ({
  createDocumentInvite: mocks.createDocumentInvite,
  generateInviteLink: (invite: { id: string; token?: string }) => `https://app.test/share/${invite.token ?? invite.id}`,
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest: mocks.audit }));

import '@pages/api/organizations/[id]/invite-links';

const ORG_ID = '65a1f77bcf86cd7994390001';
const manager = { id: 'u-owner', email: 'owner@example.com' };
const DAY = 86_400_000;

const call = async (method: 'get' | 'post', body?: unknown, user: unknown = manager) => {
  const { req, res } = createMocks({ method: method.toUpperCase() as 'GET' | 'POST', query: { id: ORG_ID }, body });
  (req as unknown as { user: unknown }).user = user;
  await refs.handlers[method](req, res);
  return res;
};

const validBody = (overrides: Record<string, unknown> = {}) => ({
  permissions: ['read'],
  expiresAt: new Date(Date.now() + 7 * DAY).toISOString(),
  ...overrides,
});

describe('/api/organizations/[id]/invite-links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findOrganization.mockResolvedValue({ id: ORG_ID, name: 'Acme', userId: 'u-owner', users: [] });
    mocks.assertCanManageOrgGroups.mockReturnValue(undefined);
    mocks.createDocumentInvite.mockResolvedValue({ id: 'inv-1', link: 'https://app.test/share/tok' });
  });

  it('404s a caller outside the organization before the manage gate', async () => {
    mocks.findOrganization.mockResolvedValue({ id: ORG_ID, userId: 'someone', users: [] });
    await expect(call('post', validBody())).rejects.toBeInstanceOf(NotFoundError);
    expect(mocks.assertCanManageOrgGroups).not.toHaveBeenCalled();
  });

  it('403s a member who cannot manage the organization, on list and create', async () => {
    mocks.assertCanManageOrgGroups.mockImplementation(() => {
      throw new ForbiddenError('nope');
    });
    await expect(call('get')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(call('post', validBody())).rejects.toBeInstanceOf(ForbiddenError);
    expect(mocks.createDocumentInvite).not.toHaveBeenCalled();
  });

  it.each([
    ['a past expiresAt', { expiresAt: new Date(Date.now() - DAY).toISOString() }],
    ['an expiresAt past 90 days', { expiresAt: new Date(Date.now() + 91 * DAY).toISOString() }],
    ['a missing expiresAt', { expiresAt: undefined }],
    ['available 0', { available: 0 }],
    ['a fractional available', { available: 1.5 }],
    ['a bad host in allowedDomains', { allowedDomains: ['not a host'] }],
    ['an unknown role', { permissions: ['share'] }],
  ])('400s %s and creates nothing', async (_label, overrides) => {
    await expect(call('post', validBody(overrides))).rejects.toBeInstanceOf(BadRequestError);
    expect(mocks.createDocumentInvite).not.toHaveBeenCalled();
  });

  it('mints a recipientless organization link with normalized domains and audits it', async () => {
    const res = await call(
      'post',
      validBody({ permissions: ['read', 'update'], available: 3, allowedDomains: ['Example.COM'] })
    );

    expect(res._getStatusCode()).toBe(201);
    expect(mocks.createDocumentInvite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: InviteType.Organization,
        id: ORG_ID,
        body: expect.objectContaining({
          link: true,
          recipients: [],
          available: 3,
          permissions: ['read', 'update'],
          allowedDomains: ['example.com'],
        }),
      })
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'org.invite_link.created',
        details: expect.objectContaining({ inviteId: 'inv-1' }),
      })
    );
  });

  it('lists only organization share links, with domains and revocation', async () => {
    const revokedAt = new Date();
    mocks.findInvites.mockResolvedValue([
      {
        id: 'link-1',
        token: 'tok-1',
        type: InviteType.Organization,
        isLinkOnly: true,
        permissions: ['read'],
        remaining: 0,
        expiresAt: null,
        recipients: { pending: [], accepted: ['a@example.com'], refused: [] },
        allowedDomains: ['example.com'],
        revokedAt,
      },
      {
        id: 'named-1',
        type: InviteType.Organization,
        isLinkOnly: false,
        remaining: 1,
        recipients: { pending: ['b@example.com'] },
      },
      { id: 'file-1', type: InviteType.FabFile, isLinkOnly: true, remaining: 5, recipients: {} },
    ]);

    const res = await call('get');

    expect(res._getJSONData()).toEqual([
      {
        id: 'link-1',
        link: 'https://app.test/share/tok-1',
        permissions: ['read'],
        expiresAt: null,
        remaining: 0,
        accepted: 1,
        allowedDomains: ['example.com'],
        revokedAt: revokedAt.toISOString(),
      },
    ]);
  });

  describe('admin-role link URLs', () => {
    const linkRow = (id: string, permissions: string[]) => ({
      id,
      token: `tok-${id}`,
      type: InviteType.Organization,
      isLinkOnly: true,
      permissions,
      remaining: 3,
      expiresAt: null,
      recipients: { pending: [], accepted: [], refused: [] },
    });
    beforeEach(() => {
      mocks.findInvites.mockResolvedValue([
        linkRow('admin-link', ['read', 'update', 'share']),
        linkRow('viewer-link', ['read']),
      ]);
    });
    const linksById = (res: { _getJSONData: () => Array<{ id: string; link: string | null }> }) =>
      Object.fromEntries(res._getJSONData().map(view => [view.id, view.link]));

    it('shows the owner every link URL, including admin-role ones', async () => {
      expect(linksById(await call('get'))).toEqual({
        'admin-link': 'https://app.test/share/tok-admin-link',
        'viewer-link': 'https://app.test/share/tok-viewer-link',
      });
    });

    it('shows a platform admin every link URL', async () => {
      const res = await call('get', undefined, { id: 'u-staff', isAdmin: true });
      expect(linksById(res)['admin-link']).toBe('https://app.test/share/tok-admin-link');
    });

    it('withholds admin-role link URLs from a non-owner manager but still lists them', async () => {
      mocks.findOrganization.mockResolvedValue({
        id: ORG_ID,
        name: 'Acme',
        userId: 'u-owner',
        users: [{ userId: 'u-manager', permissions: ['read'] }],
      });
      const res = await call('get', undefined, { id: 'u-manager', email: 'manager@example.com' });
      expect(linksById(res)).toEqual({
        'admin-link': null,
        'viewer-link': 'https://app.test/share/tok-viewer-link',
      });
      expect(JSON.stringify(res._getJSONData())).not.toContain('tok-admin-link');
    });
  });
});
