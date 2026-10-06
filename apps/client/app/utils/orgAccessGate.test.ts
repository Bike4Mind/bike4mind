import { describe, it, expect } from 'vitest';
import { hasOrgUpdateAccess } from './orgAccessGate';

/** Mirrors server/utils/orgAccess.ts verifyOrgAccess - owner or manager, plus platform admins. */
describe('hasOrgUpdateAccess', () => {
  const org = { userId: 'owner-1', managerId: 'manager-1' };

  it('admits the billing owner', () => {
    expect(hasOrgUpdateAccess({ id: 'owner-1' }, org)).toBe(true);
  });

  it('admits the team manager', () => {
    expect(hasOrgUpdateAccess({ id: 'manager-1' }, org)).toBe(true);
  });

  it('admits a platform admin who is neither', () => {
    expect(hasOrgUpdateAccess({ id: 'someone-else', isAdmin: true }, org)).toBe(true);
  });

  it('refuses a plain member', () => {
    expect(hasOrgUpdateAccess({ id: 'member-1' }, org)).toBe(false);
  });

  // Fails closed: an unresolved user or org must never light an owner/manager-only control.
  it('refuses a missing user or organization', () => {
    expect(hasOrgUpdateAccess(null, org)).toBe(false);
    expect(hasOrgUpdateAccess({ id: 'owner-1' }, null)).toBe(false);
    expect(hasOrgUpdateAccess({ id: 'owner-1' }, undefined)).toBe(false);
  });

  it('does not treat an absent managerId as a match for an unknown id', () => {
    expect(hasOrgUpdateAccess({ id: 'member-1' }, { userId: 'owner-1', managerId: null })).toBe(false);
  });
});
