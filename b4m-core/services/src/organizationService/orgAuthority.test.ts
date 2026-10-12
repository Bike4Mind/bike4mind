import { describe, it, expect } from 'vitest';
import { canAdministerOrganization as commonCanAdministerOrganization } from '@bike4mind/common';
import { canAdministerOrganization, isCurrentOrgMember } from './orgAuthority';

describe('canAdministerOrganization', () => {
  it('re-exports the common predicate rather than a copy', () => {
    expect(canAdministerOrganization).toBe(commonCanAdministerOrganization);
  });
});

describe('isCurrentOrgMember', () => {
  const org = {
    userId: 'owner-id',
    managerId: 'manager-id',
    users: [{ userId: 'member-id' }, { userId: 'other-member-id' }],
  };

  it('counts the billing owner', () => {
    expect(isCurrentOrgMember(org, 'owner-id')).toBe(true);
  });

  it('counts the appointed manager', () => {
    expect(isCurrentOrgMember(org, 'manager-id')).toBe(true);
  });

  it('counts a user on the roster', () => {
    expect(isCurrentOrgMember(org, 'member-id')).toBe(true);
  });

  it('refuses a user no longer on the roster', () => {
    expect(isCurrentOrgMember(org, 'removed-user-id')).toBe(false);
  });

  it('refuses when the roster is absent', () => {
    expect(isCurrentOrgMember({ userId: 'owner-id' }, 'member-id')).toBe(false);
  });

  // Defensive, not observed: `UserShareableSchema` declares `users[].userId` as a String, so the
  // roster is not subject to the ObjectId trap that made the self-leave pointer clear a no-op. The
  // normalization is kept (and pinned here) so an id arriving from any other shape still matches.
  it('matches a roster entry whose userId stringifies rather than being a string', () => {
    const hydrated = {
      userId: 'owner-id',
      users: [{ userId: { toString: () => 'member-id' } as unknown as string }],
    };
    expect(isCurrentOrgMember(hydrated, 'member-id')).toBe(true);
  });

  // Membership is a factual relationship to the roster, deliberately NOT authority: a platform
  // admin's involvement must not change whose credit pool an org-billed key spends.
  it('does not count a platform admin who is not on the roster', () => {
    expect(isCurrentOrgMember(org, 'platform-admin-id')).toBe(false);
  });
});
