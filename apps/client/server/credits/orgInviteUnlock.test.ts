import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InviteType } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  invite: vi.fn(),
  acceptedInvite: vi.fn(),
  memberships: vi.fn(),
  unlock: vi.fn(),
  setting: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { findBySettingName: h.setting },
  creditLotRepository: {},
  creditTransactionRepository: {},
  userRepository: {},
  inviteRepository: { findById: h.invite, findOne: h.acceptedInvite },
  organizationRepository: { findMembershipOrgIds: h.memberships },
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
    h.unlock.mockImplementation(async (_id, _reason, adapters) =>
      adapters.validators.org_invite({ id: 'user-1', email: 'USER@example.test' })
    );
  });
  it('requires actual accepted recipients and authoritative membership', async () => {
    expect(await unlockSignupGrantFromOrgInvite('user-1', 'invite-1')).toBe(true);
    expect(h.unlock).toHaveBeenCalledWith('user-1', 'org_invite', expect.anything());
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
    h.acceptedInvite.mockResolvedValue(acceptedInvite);
    h.unlock.mockImplementation(async (_id, _reason, adapters) =>
      adapters.validators.org_invite({ id: 'user-1', email: 'NAME+TAG@example.test' })
    );
  });

  it('finds a persisted acceptance after the pending inbox entry is gone, with literal case-insensitive email matching', async () => {
    expect(await unlockSignupGrantFromAcceptedOrgInvite('user-1')).toBe(true);
    expect(h.acceptedInvite).toHaveBeenCalledExactlyOnceWith({
      type: InviteType.Organization,
      documentId: { $in: ['org-1'] },
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
      adapters.validators.org_invite({ id: 'user-1', email: 'user@example.test' })
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
    expect(await unlock()).toBe(true);
    expect(h.memberships).toHaveBeenCalledExactlyOnceWith('user-1');
  });
});
