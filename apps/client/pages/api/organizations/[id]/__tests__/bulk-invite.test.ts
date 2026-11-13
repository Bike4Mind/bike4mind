import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { BadRequestError, ConflictError, ForbiddenError, InviteType, NotFoundError } from '@bike4mind/common';

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: unknown, res: unknown) => unknown),
  postMiddleware: [] as unknown[],
  gate: Symbol('outboundActionGate'),
}));

vi.mock('@server/auth/assertOutboundActionAllowed', () => ({
  outboundActionGate: () => mockRefs.gate,
}));
vi.mock('@server/middlewares/baseApi', () => {
  type Chain = { use: () => Chain; post: (...fns: unknown[]) => Chain };
  const chain: Chain = {
    use: () => chain,
    post: (...fns) => {
      mockRefs.postMiddleware = fns.slice(0, -1);
      mockRefs.postHandler = fns[fns.length - 1] as (req: unknown, res: unknown) => unknown;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));

const mocks = vi.hoisted(() => ({
  createInvite: vi.fn(),
  assertCanManageOrgGroups: vi.fn(),
  findOrganization: vi.fn(),
  findUsersByIds: vi.fn(),
  findUserById: vi.fn(),
  findInvites: vi.fn(),
  tryAddWithinLimitFixedWindow: vi.fn(),
  decrementCounter: vi.fn(),
}));
vi.mock('@bike4mind/services', async () => {
  const { classifyOrgInviteRows } =
    await import('../../../../../../../b4m-core/services/src/sharingService/classifyOrgInviteRows');
  const { pendingOrgInviteRecipients } =
    await import('../../../../../../../b4m-core/services/src/sharingService/orgSeatReservations');
  return {
    sharingService: { createInvite: mocks.createInvite, classifyOrgInviteRows, pendingOrgInviteRecipients },
    organizationService: { assertCanManageOrgGroups: mocks.assertCanManageOrgGroups },
  };
});
vi.mock('@server/utils/mailer/inviteNotificationEmail', () => ({
  getInviteTypeName: () => 'organization',
  sendInviteNotificationEmails: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@bike4mind/database', () => ({
  cacheRepository: {
    tryAddWithinLimitFixedWindow: mocks.tryAddWithinLimitFixedWindow,
    decrementCounter: mocks.decrementCounter,
  },
  User: { find: () => ({ collation: () => ({ lean: () => Promise.resolve([]) }) }) },
  FabFile: {},
  Group: {},
  Session: {},
  Organization: { findById: () => Promise.resolve({ name: 'Acme' }) },
  withTransaction: (fn: () => unknown) => fn(),
  fabFileRepository: {},
  sessionRepository: {},
  userRepository: { findByIds: mocks.findUsersByIds, findById: mocks.findUserById },
  organizationRepository: { findById: mocks.findOrganization },
  projectRepository: {},
  inviteRepository: { findAllByDocumentId: mocks.findInvites },
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  recordAdminActionFromRequest: vi.fn().mockResolvedValue(null),
}));
vi.mock('@bike4mind/server-utils/utils/organizationAudit', () => ({
  recordOrganizationAuditEvent: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({ EmailEvents: { Send: { publish: vi.fn() } } }));

import '@pages/api/organizations/[id]/bulk-invite';

const ORG_ID = '65a1f77bcf86cd7994390001';
const FITS = { success: true, expiresAt: new Date(Date.now() + 60_000) };
const REFUSED = { success: false, expiresAt: new Date(Date.now() + 60_000) };

// seats 5: owner + one member + one pending invite leaves 2.
const organization = {
  id: ORG_ID,
  userId: 'owner',
  seats: 5,
  users: [{ userId: 'member-1', permissions: ['read'] }],
};

const call = async (body: unknown, user: Record<string, unknown> = { id: 'owner', email: 'owner@example.com' }) => {
  const { req, res } = createMocks({ method: 'POST', query: { id: ORG_ID }, body: body as Record<string, unknown> });
  Object.assign(req, { user, ability: {}, logger: { warn: vi.fn(), error: vi.fn() } });
  await mockRefs.postHandler!(req, res);
  return res;
};

const statusOf = async (body: unknown, user?: Record<string, unknown>) => {
  try {
    await call(body, user);
    return 'resolved';
  } catch (error) {
    return error;
  }
};

describe('POST /api/organizations/:id/bulk-invite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertCanManageOrgGroups.mockReset();
    mocks.tryAddWithinLimitFixedWindow.mockResolvedValue(FITS);
    mocks.findOrganization.mockResolvedValue(organization);
    mocks.findUsersByIds.mockResolvedValue([{ id: 'member-1', email: 'Member@Example.com' }]);
    mocks.findUserById.mockResolvedValue({ id: 'owner', email: 'owner@example.com' });
    mocks.findInvites.mockResolvedValue([
      { type: InviteType.Organization, remaining: 1, recipients: { pending: ['pending@example.com'] } },
    ]);
    mocks.createInvite.mockImplementation(async (_user: unknown, { recipients }: { recipients: string[] }) => ({
      id: 'inv-1',
      token: 'tok-1',
      documentId: ORG_ID,
      type: InviteType.Organization,
      recipients: { pending: recipients, accepted: [], refused: [] },
    }));
  });

  it('runs behind the outbound action gate', () => {
    expect(mockRefs.postMiddleware).toEqual([mockRefs.gate]);
  });

  it.each([
    ['non-array emails', { emails: 'a@example.com', permissions: ['read'] }],
    ['no emails', { emails: [], permissions: ['read'] }],
    ['101 emails', { emails: Array.from({ length: 101 }, (_, i) => `u${i}@example.com`), permissions: ['read'] }],
    ['a permission set that is no role', { emails: ['a@example.com'], permissions: ['share'] }],
  ])('rejects %s with 400 before touching the organization', async (_label, body) => {
    expect(await statusOf(body)).toBeInstanceOf(BadRequestError);
    expect(mocks.findOrganization).not.toHaveBeenCalled();
    expect(mocks.createInvite).not.toHaveBeenCalled();
  });

  it('hides the organization from a non-member', async () => {
    const error = await statusOf({ emails: ['a@example.com'], permissions: ['read'] }, { id: 'stranger' });
    expect(error).toBeInstanceOf(NotFoundError);
    expect(mocks.createInvite).not.toHaveBeenCalled();
  });

  it('refuses a member who cannot manage the organization', async () => {
    mocks.assertCanManageOrgGroups.mockImplementation(() => {
      throw new ForbiddenError('Only organization admins can do this');
    });
    const error = await statusOf({ emails: ['a@example.com'], permissions: ['read'] }, { id: 'member-1' });
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(mocks.createInvite).not.toHaveBeenCalled();
  });

  it.each([
    ['some invitable rows', ['new1@example.com']],
    ['no invitable rows', ['member@example.com', 'bad']],
  ])('403s a non-owner manager inviting admins with %s', async (_label, emails) => {
    const error = await statusOf(
      { emails, permissions: ['read', 'update', 'share'] },
      { id: 'member-1', email: 'member@example.com' }
    );
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(mocks.findUsersByIds).not.toHaveBeenCalled();
    expect(mocks.createInvite).not.toHaveBeenCalled();
  });

  it('classifies each row and invites only the new ones, charging the org-bulk bucket', async () => {
    const res = await call({
      emails: [
        'new1@example.com',
        'MEMBER@example.com',
        'nope',
        'pending@example.com',
        'new2@example.com',
        'new3@example.com',
      ],
      permissions: ['read', 'update'],
    });

    expect(res._getStatusCode()).toBe(200);
    const data = res._getJSONData();
    expect(data.rows.map((row: { status: string }) => row.status)).toEqual([
      'invite',
      'already_member',
      'invalid',
      'already_pending',
      'invite',
      'seat_limit',
    ]);
    expect(data).toMatchObject({ invitedCount: 2, inviteId: 'inv-1' });
    expect(mocks.createInvite).toHaveBeenCalledOnce();
    expect(mocks.createInvite.mock.calls[0][1]).toMatchObject({
      type: InviteType.Organization,
      id: ORG_ID,
      permissions: ['read', 'update'],
      recipients: ['new1@example.com', 'new2@example.com'],
    });
    expect(mocks.tryAddWithinLimitFixedWindow).toHaveBeenCalledWith(
      'rate-limit:owner:org-bulk-typed-address',
      2,
      100,
      expect.any(Number)
    );
  });

  it('creates nothing and charges nothing when no row is invitable', async () => {
    const res = await call({ emails: ['member@example.com', 'bad'], permissions: ['read'] });

    expect(res._getJSONData()).toMatchObject({ invitedCount: 0, inviteId: null });
    expect(mocks.tryAddWithinLimitFixedWindow).not.toHaveBeenCalled();
    expect(mocks.createInvite).not.toHaveBeenCalled();
  });

  it('creates nothing when the send budget refuses', async () => {
    mocks.tryAddWithinLimitFixedWindow.mockResolvedValueOnce(FITS).mockResolvedValueOnce(REFUSED);

    const error = await statusOf({ emails: ['new1@example.com'], permissions: ['read'] });
    expect((error as Error).message).toMatch(/Too many email invitations/);
    expect(mocks.createInvite).not.toHaveBeenCalled();
  });

  it.each(['Organization is full', 'A recipient already has a pending organization invitation'])(
    'reports a roster change during creation (%s) as 409 and gives the budget back',
    async message => {
      mocks.createInvite.mockRejectedValueOnce(new BadRequestError(message));

      const error = await statusOf({ emails: ['new1@example.com'], permissions: ['read'] });
      expect(error).toBeInstanceOf(ConflictError);
      expect(mocks.decrementCounter).toHaveBeenCalled();
    }
  );
});
