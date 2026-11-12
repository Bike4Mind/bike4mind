import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { BadRequestError, ForbiddenError, InviteType, NotFoundError } from '@bike4mind/common';
import { TooManyRequestsError } from '@bike4mind/utils';

const refs = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => unknown),
  middleware: [] as unknown[],
  gate: Symbol('outboundActionGate'),
}));
vi.mock('@server/auth/assertOutboundActionAllowed', () => ({ outboundActionGate: () => refs.gate }));
vi.mock('@server/middlewares/baseApi', () => {
  type Chain = { use: () => Chain; post: (...fns: unknown[]) => Chain };
  const chain: Chain = {
    use: () => chain,
    post: (...fns) => {
      refs.middleware = fns.slice(0, -1);
      refs.handler = fns[fns.length - 1] as (req: unknown, res: unknown) => unknown;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));

const mocks = vi.hoisted(() => ({
  loadManagedOrganization: vi.fn(),
  findInvites: vi.fn(),
  findUserById: vi.fn(),
  tryAdd: vi.fn(),
  decrementCounter: vi.fn(),
  reserve: vi.fn(),
  release: vi.fn(),
  notify: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  inviteRepository: { findAllByDocumentId: mocks.findInvites },
  userRepository: { findById: mocks.findUserById },
  cacheRepository: { tryAddWithinLimitFixedWindow: mocks.tryAdd, decrementCounter: mocks.decrementCounter },
}));
vi.mock('@server/organizations/orgInviteLinks', () => ({ loadManagedOrganization: mocks.loadManagedOrganization }));
vi.mock('@server/utils/inviteSendLimits', () => ({
  reserveInviteSendBudget: mocks.reserve,
  notifyInvitees: mocks.notify,
}));
vi.mock('@server/managers/createDocumentInvite', () => ({
  generateInviteLink: (invite: { id: string; token?: string }) => `https://app.test/share/${invite.token ?? invite.id}`,
}));
vi.mock('@server/utils/mailer/inviteNotificationEmail', () => ({ getInviteTypeName: () => 'organization' }));

import { INVITE_RESEND_COOLDOWN_MS } from '@pages/api/organizations/[id]/invite-resend';

const ORG_ID = '65a1f77bcf86cd7994390001';
const INVITE = {
  id: 'invite-1',
  token: 'tok-1',
  documentId: ORG_ID,
  type: InviteType.Organization,
  remaining: 2,
  expiresAt: null,
  revokedAt: null,
  description: 'Join us',
  recipients: { pending: ['new@example.test', 'two@example.test'], accepted: [], refused: [] },
};

const resend = async (body: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: 'POST', query: { id: ORG_ID }, body });
  (req as unknown as { user: unknown }).user = { id: 'u-owner', name: 'Owner', email: 'owner@example.test' };
  await refs.handler!(req, res);
  return res;
};

describe('POST /api/organizations/[id]/invite-resend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadManagedOrganization.mockResolvedValue({ id: ORG_ID, name: 'Acme' });
    mocks.findInvites.mockResolvedValue([INVITE]);
    mocks.reserve.mockResolvedValue({ release: mocks.release });
    mocks.tryAdd.mockResolvedValue({ success: true, count: 1, expiresAt: new Date() });
    mocks.notify.mockResolvedValue(undefined);
  });

  it('sits behind the outbound action gate', () => {
    expect(refs.middleware).toContain(refs.gate);
  });

  it('resends a typed address, charging the typed budget and a per-invite cooldown', async () => {
    const res = await resend({ email: ' new@example.test ' });
    expect(res._getJSONData()).toEqual({ resent: true });
    expect(mocks.reserve).toHaveBeenCalledWith('u-owner', ['new@example.test'], {
      chargeTypedAddresses: true,
      typedAddressBucket: 'orgBulk',
    });
    expect(mocks.tryAdd).toHaveBeenCalledWith(
      'rate-limit:invite-resend:invite-1:new@example.test',
      1,
      1,
      INVITE_RESEND_COOLDOWN_MS
    );
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        recipients: ['new@example.test'],
        documentName: 'Acme',
        inviteLink: 'https://app.test/share/tok-1',
        message: 'Join us',
      })
    );
  });

  it('resends to a pending account by user id, matching the address stored in pending', async () => {
    mocks.findUserById.mockResolvedValue({ id: 'user-2', email: 'Two@Example.test' });
    const res = await resend({ userId: 'user-2' });
    expect(res._getJSONData()).toEqual({ resent: true });
    expect(mocks.reserve).toHaveBeenCalledWith('u-owner', ['two@example.test'], {
      chargeTypedAddresses: false,
      typedAddressBucket: 'orgBulk',
    });
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ recipients: ['two@example.test'] }));
  });

  it('refuses a second resend inside the cooldown and gives the budget back', async () => {
    mocks.tryAdd.mockResolvedValue({ success: false, count: 1, expiresAt: new Date() });
    await expect(resend({ email: 'new@example.test' })).rejects.toBeInstanceOf(TooManyRequestsError);
    expect(mocks.release).toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('sends nothing when the send budget is spent', async () => {
    mocks.reserve.mockRejectedValue(new TooManyRequestsError('Too many invitations. Try again later.'));
    await expect(resend({ email: 'new@example.test' })).rejects.toBeInstanceOf(TooManyRequestsError);
    expect(mocks.tryAdd).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('releases the budget and cooldown when the email fails', async () => {
    mocks.notify.mockRejectedValue(new Error('mailer down'));
    await expect(resend({ email: 'new@example.test' })).rejects.toThrow('mailer down');
    expect(mocks.release).toHaveBeenCalled();
    expect(mocks.decrementCounter).toHaveBeenCalledWith('rate-limit:invite-resend:invite-1:new@example.test');
  });

  it.each([
    ['an address that is not pending', [INVITE], { email: 'other@example.test' }],
    ['a revoked invite', [{ ...INVITE, revokedAt: new Date() }], { email: 'new@example.test' }],
    ['an expired invite', [{ ...INVITE, expiresAt: new Date(Date.now() - 1000) }], { email: 'new@example.test' }],
    ['a used-up invite', [{ ...INVITE, remaining: 0 }], { email: 'new@example.test' }],
    ['another document invite', [{ ...INVITE, documentId: 'other-org' }], { email: 'new@example.test' }],
    ['a non-organization invite', [{ ...INVITE, type: InviteType.FabFile }], { email: 'new@example.test' }],
    ['a user id whose account is not pending', [INVITE], { userId: 'user-3' }],
    ['a user id with no account', [INVITE], { userId: 'missing' }],
  ])('404s %s without sending', async (_label, invites, body) => {
    mocks.findInvites.mockResolvedValue(invites);
    mocks.findUserById.mockImplementation(async (id: string) =>
      id === 'user-3' ? { id, email: 'three@example.test' } : null
    );
    await expect(resend(body)).rejects.toBeInstanceOf(NotFoundError);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ email: 'a@example.test', userId: 'user-2' }]])('400s a body naming %j', async body => {
    await expect(resend(body)).rejects.toBeInstanceOf(BadRequestError);
  });

  it('403s a member who cannot manage the organization', async () => {
    mocks.loadManagedOrganization.mockRejectedValue(new ForbiddenError('nope'));
    await expect(resend({ email: 'new@example.test' })).rejects.toBeInstanceOf(ForbiddenError);
    expect(mocks.findInvites).not.toHaveBeenCalled();
  });
});
