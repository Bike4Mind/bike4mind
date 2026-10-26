import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InviteType } from '@bike4mind/common';

const h = vi.hoisted(() => ({ invite: vi.fn(), memberships: vi.fn(), unlock: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  creditLotRepository: {},
  creditTransactionRepository: {},
  userRepository: {},
  inviteRepository: { findById: h.invite },
  organizationRepository: { findMembershipOrgIds: h.memberships },
}));
vi.mock('@bike4mind/services', () => ({ userService: { unlockSignupGrant: h.unlock } }));
import { unlockSignupGrantFromOrgInvite } from './orgInviteUnlock';

describe('organization invite unlock evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
