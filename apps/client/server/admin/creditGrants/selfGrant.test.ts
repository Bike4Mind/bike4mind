import { describe, expect, it } from 'vitest';
import type { AdminApproval } from '@bike4mind/common';
import { SELF_GRANT_APPROVAL, isApprovedSelfGrant, isHeldSelfGrant } from './selfGrant';

describe('isHeldSelfGrant', () => {
  it('holds a full admin granting to themselves', () => {
    expect(isHeldSelfGrant({ id: 'a', isAdmin: true }, true)).toBe(true);
  });

  it('lets an admin holding credits:self_grant, directly or by role, grant to themselves', () => {
    expect(isHeldSelfGrant({ id: 'a', isAdmin: true, adminPermissions: ['credits:self_grant'] }, true)).toBe(false);
    expect(isHeldSelfGrant({ id: 'a', isAdmin: true, roleAdminPermissions: ['credits:self_grant'] }, true)).toBe(false);
  });

  it('never holds a grant to someone else', () => {
    expect(isHeldSelfGrant({ id: 'a', isAdmin: true }, false)).toBe(false);
  });
});

describe('SELF_GRANT_APPROVAL', () => {
  it('asks for credits:approve_self_grant without requiring a full admin', () => {
    expect(SELF_GRANT_APPROVAL).toEqual({ requiredPermission: 'credits:approve_self_grant', requiresFullAdmin: false });
  });
});

describe('isApprovedSelfGrant', () => {
  const approvalWith = (requiredPermission: string) => ({ requiredPermission }) as unknown as AdminApproval;

  it('is true for an approval requested with credits:approve_self_grant', () => {
    expect(isApprovedSelfGrant(approvalWith('credits:approve_self_grant'))).toBe(true);
  });

  it('is false for an ordinary credit approval', () => {
    expect(isApprovedSelfGrant(approvalWith('credits:adjust'))).toBe(false);
  });

  it('is false when the executor runs without an approval', () => {
    expect(isApprovedSelfGrant(undefined)).toBe(false);
  });
});
