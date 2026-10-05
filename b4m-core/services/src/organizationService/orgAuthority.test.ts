import { describe, it, expect } from 'vitest';
import { canAdministerOrganization, isCurrentOrgMember } from './orgAuthority';

describe('canAdministerOrganization', () => {
  const org = { userId: 'owner-id', managerId: 'manager-id' };

  it('admits the billing owner', () => {
    expect(canAdministerOrganization({ id: 'owner-id' }, org)).toBe(true);
  });

  it('admits the appointed manager', () => {
    expect(canAdministerOrganization({ id: 'manager-id' }, org)).toBe(true);
  });

  it('admits a platform admin who is neither', () => {
    expect(canAdministerOrganization({ id: 'someone-else', isAdmin: true }, org)).toBe(true);
  });

  // The finding this predicate exists for: roster administration used to gate on the membership
  // ACL, which every ordinary member satisfies.
  it('refuses a plain member', () => {
    expect(canAdministerOrganization({ id: 'member-id' }, org)).toBe(false);
  });

  it('refuses a stranger', () => {
    expect(canAdministerOrganization({ id: 'nobody' }, org)).toBe(false);
  });

  // A null managerId must not match a caller whose id is somehow also nullish - fail closed on a
  // blank identity rather than admitting on `undefined === undefined`.
  it('does not admit on a null managerId', () => {
    expect(
      canAdministerOrganization({ id: undefined as unknown as string }, { userId: 'owner-id', managerId: null })
    ).toBe(false);
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
