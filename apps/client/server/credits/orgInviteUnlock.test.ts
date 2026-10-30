import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InviteType } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  invite: vi.fn(),
  acceptedInvite: vi.fn(),
  memberships: vi.fn(),
  reserve: vi.fn(),
  missingCounter: vi.fn(),
  org: vi.fn(),
  count: vi.fn(),
  unlock: vi.fn(),
  setting: vi.fn(),
  protection: { repository: {} },
}));
vi.mock('@server/auth/signupProtection', () => ({ signupProtection: h.protection }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { findBySettingName: h.setting },
  creditLotRepository: {},
  creditTransactionRepository: {},
  userRepository: { count: h.count },
  inviteRepository: { findById: h.invite, findOne: h.acceptedInvite },
  organizationRepository: { findMembershipOrgIds: h.memberships, findById: h.org },
  Organization: { updateOne: h.reserve, exists: h.missingCounter },
}));
vi.mock('@bike4mind/services', () => ({ userService: { unlockSignupGrant: h.unlock } }));
import { unlockSignupGrantFromOrgInvite, unlockSignupGrantFromAcceptedOrgInvite } from './orgInviteUnlock';

describe('organization invite unlock evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.setting.mockResolvedValue({ settingValue: 'true' });
    h.invite.mockResolvedValue({
      type: InviteType.Organization,
      documentId: 'org-1',
      recipients: { accepted: ['user@example.test'] },
    });
    h.memberships.mockResolvedValue(['org-1']);
    h.reserve.mockResolvedValue({ modifiedCount: 1 });
    h.missingCounter.mockResolvedValue({ _id: 'org-1' });
    h.org.mockResolvedValue({ seats: 3 });
    h.count.mockResolvedValue(2);
    h.unlock.mockImplementation(async (_id, _reason, adapters) =>
      adapters.validators.org_invite({
        id: 'user-1',
        email: 'USER@example.test',
        signupGrant: { signupCredits: 12, unlockCredits: 28, creditsReleased: 12 },
      })
    );
  });
  it('requires actual accepted recipients and authoritative membership', async () => {
    expect(await unlockSignupGrantFromOrgInvite('user-1', 'invite-1')).toEqual({ unlockedOrgId: 'org-1' });
    expect(h.unlock).toHaveBeenCalledWith('user-1', 'org_invite', expect.anything());
    expect(h.unlock.mock.calls[0][2].db.signupProtection).toBe(h.protection);
    expect(h.count).toHaveBeenCalledExactlyOnceWith({ 'signupGrant.unlockedOrgId': 'org-1' });
    expect(h.reserve.mock.calls).toEqual([
      [{ _id: 'org-1', signupGrantUnlockCount: { $exists: false } }, { $set: { signupGrantUnlockCount: 2 } }],
      [
        { _id: 'org-1', $expr: { $lt: ['$signupGrantUnlockCount', '$seats'] } },
        { $inc: { signupGrantUnlockCount: 1 } },
      ],
    ]);
  });
  it('does not reserve a slot for an already fully released grant', async () => {
    h.unlock.mockImplementation(async (_id, _reason, adapters) =>
      adapters.validators.org_invite({
        id: 'user-1',
        email: 'user@example.test',
        signupGrant: { signupCredits: 12, unlockCredits: 28, creditsReleased: 40 },
      })
    );
    expect(await unlockSignupGrantFromOrgInvite('user-1', 'invite-1')).toBe(false);
    expect(h.reserve).not.toHaveBeenCalled();
  });
  it('uses the durable counter without recounting recipients after initialization', async () => {
    h.missingCounter.mockResolvedValue(null);
    expect(await unlockSignupGrantFromOrgInvite('user-1', 'invite-1')).toEqual({ unlockedOrgId: 'org-1' });
    expect(h.count).not.toHaveBeenCalled();
    expect(h.reserve).toHaveBeenCalledExactlyOnceWith(
      { _id: 'org-1', $expr: { $lt: ['$signupGrantUnlockCount', '$seats'] } },
      { $inc: { signupGrantUnlockCount: 1 } }
    );
  });
  it.each([0, -1, 1.5, NaN, Infinity])('rejects an invalid seat budget %s', async seats => {
    h.org.mockResolvedValue({ seats });
    expect(await unlockSignupGrantFromOrgInvite('user-1', 'invite-1')).toBe(false);
    expect(h.reserve).not.toHaveBeenCalled();
  });
  it('stops unlocking once the organization has vouched for as many accounts as it has seats', async () => {
    h.reserve.mockResolvedValue({ modifiedCount: 0 });
    expect(await unlockSignupGrantFromOrgInvite('user-1', 'invite-1')).toBe(false);
  });
  it('rejects an invite whose organization no longer exists', async () => {
    h.org.mockResolvedValue(null);
    expect(await unlockSignupGrantFromOrgInvite('user-1', 'invite-1')).toBe(false);
  });
  it('rejects pending invitations', async () => {
    h.invite.mockResolvedValue({
      type: InviteType.Organization,
      documentId: 'org-1',
      recipients: { accepted: [], pending: ['user@example.test'] },
    });
    expect(await unlockSignupGrantFromOrgInvite('user-1', 'invite-1')).toBe(false);
  });
  it('rejects a profile organization pointer without actual membership', async () => {
    h.memberships.mockResolvedValue([]);
    expect(await unlockSignupGrantFromOrgInvite('user-1', 'invite-1')).toBe(false);
  });
  it('rejects a different kind of accepted invite', async () => {
    h.invite.mockResolvedValue({
      type: InviteType.Project,
      documentId: 'org-1',
      recipients: { accepted: ['user@example.test'] },
    });
    expect(await unlockSignupGrantFromOrgInvite('user-1', 'invite-1')).toBe(false);
  });
});

describe('accepted organization invite retries', () => {
  const acceptedInvite = {
    type: InviteType.Organization,
    documentId: 'org-1',
    recipients: { accepted: ['name+tag@example.test'] },
  };
  beforeEach(() => {
    vi.clearAllMocks();
    h.setting.mockResolvedValue({ settingValue: 'true' });
    h.memberships.mockResolvedValue(['org-1']);
    h.reserve.mockResolvedValue({ modifiedCount: 1 });
    h.missingCounter.mockResolvedValue({ _id: 'org-1' });
    h.org.mockResolvedValue({ seats: 3 });
    h.count.mockResolvedValue(2);
    h.acceptedInvite.mockResolvedValue(acceptedInvite);
    h.unlock.mockImplementation(async (_id, _reason, adapters) =>
      adapters.validators.org_invite({
        id: 'user-1',
        email: 'NAME+TAG@example.test',
        signupGrant: { signupCredits: 12, unlockCredits: 28, creditsReleased: 12 },
      })
    );
  });

  it('finds a persisted acceptance after the pending inbox entry is gone, with literal case-insensitive email matching', async () => {
    expect(await unlockSignupGrantFromAcceptedOrgInvite('user-1')).toEqual({ unlockedOrgId: 'org-1' });
    expect(h.acceptedInvite).toHaveBeenCalledExactlyOnceWith({
      type: InviteType.Organization,
      documentId: 'org-1',
      'recipients.accepted': { $regex: '^NAME\\+TAG@example\\.test$', $options: 'i' },
    });
    const filter = h.acceptedInvite.mock.calls[0][0] as {
      'recipients.accepted': { $regex: string; $options: string };
    };
    const matcher = new RegExp(filter['recipients.accepted'].$regex, filter['recipients.accepted'].$options);
    expect(matcher.test('name+tag@example.test')).toBe(true);
    expect(matcher.test('nameeeetag@exampleXtest')).toBe(false);
    expect(matcher.test('othername+tag@example.test')).toBe(false);
    expect(h.invite).not.toHaveBeenCalled();
  });

  it('does not query invitations without authoritative membership', async () => {
    h.memberships.mockResolvedValue([]);
    expect(await unlockSignupGrantFromAcceptedOrgInvite('user-1')).toBe(false);
    expect(h.acceptedInvite).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { ...acceptedInvite, recipients: { accepted: [], pending: ['name+tag@example.test'] } },
    { ...acceptedInvite, documentId: 'other-org' },
    { ...acceptedInvite, type: InviteType.Project },
    { ...acceptedInvite, recipients: { accepted: ['different@example.test'] } },
  ])('rejects absent or mismatched persisted acceptance %j', async invite => {
    h.acceptedInvite.mockResolvedValue(invite);
    expect(await unlockSignupGrantFromAcceptedOrgInvite('user-1')).toBe(false);
  });

  it('caps the durable retry path at the organization seat count too', async () => {
    h.reserve.mockResolvedValue({ modifiedCount: 0 });
    expect(await unlockSignupGrantFromAcceptedOrgInvite('user-1')).toBe(false);
    expect(h.count).toHaveBeenCalledExactlyOnceWith({ 'signupGrant.unlockedOrgId': 'org-1' });
  });

  it('propagates failed evidence reads instead of granting', async () => {
    h.acceptedInvite.mockRejectedValueOnce(new Error('store unavailable'));
    await expect(unlockSignupGrantFromAcceptedOrgInvite('user-1')).rejects.toThrow('store unavailable');
  });
});

describe.each([
  ['acceptance', () => unlockSignupGrantFromOrgInvite('user-1', 'invite-1')],
  ['durable retry', () => unlockSignupGrantFromAcceptedOrgInvite('user-1')],
] as const)('organization unlock rollout: %s', (_label, unlock) => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.memberships.mockResolvedValue(['org-1']);
    h.reserve.mockResolvedValue({ modifiedCount: 1 });
    h.missingCounter.mockResolvedValue({ _id: 'org-1' });
    h.org.mockResolvedValue({ seats: 3 });
    h.count.mockResolvedValue(2);
    h.invite.mockResolvedValue({
      type: InviteType.Organization,
      documentId: 'org-1',
      recipients: { accepted: ['user@example.test'] },
    });
    h.acceptedInvite.mockResolvedValue({
      type: InviteType.Organization,
      documentId: 'org-1',
      recipients: { accepted: ['user@example.test'] },
    });
    h.unlock.mockImplementation(async (_id, _reason, adapters) =>
      adapters.validators.org_invite({
        id: 'user-1',
        email: 'user@example.test',
        signupGrant: { signupCredits: 12, unlockCredits: 28, creditsReleased: 12 },
      })
    );
  });

  it.each([undefined, false, 'false', '', 'TRUE', 1])('does not look up evidence when the flag is %j', async flag => {
    h.setting.mockResolvedValue(flag === undefined ? null : { settingValue: flag });
    expect(await unlock()).toBe(false);
    expect(h.setting).toHaveBeenCalledExactlyOnceWith('signupGrantOrgInviteEnabled');
    expect(h.memberships).not.toHaveBeenCalled();
    expect(h.invite).not.toHaveBeenCalled();
    expect(h.acceptedInvite).not.toHaveBeenCalled();
  });

  it.each([true, 'true'])('allows authoritative evidence only when explicitly enabled as %j', async flag => {
    h.setting.mockResolvedValue({ settingValue: flag });
    expect(await unlock()).toEqual({ unlockedOrgId: 'org-1' });
    expect(h.memberships).toHaveBeenCalledExactlyOnceWith('user-1');
  });
});
