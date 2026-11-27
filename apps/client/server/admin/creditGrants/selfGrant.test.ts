import { describe, expect, it, vi } from 'vitest';
import type { AdminApproval } from '@bike4mind/common';

// Fake id only: the senior granter list (seniorGranters.ts) fences credits:self_grant.
const LISTED = vi.hoisted(() => 'a00000000000000000000001');
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { ADMIN_SENIOR_GRANTER_IDS: LISTED } }));

import { SELF_GRANT_APPROVAL, isApprovedSelfGrant, isHeldSelfGrant } from './selfGrant';

describe('isHeldSelfGrant', () => {
  it('holds a full admin granting to themselves', () => {
    expect(isHeldSelfGrant({ id: 'a', isAdmin: true }, true)).toBe(true);
  });

  it('lets a listed admin holding credits:self_grant, directly or by role, grant to themselves', () => {
    expect(isHeldSelfGrant({ id: LISTED, isAdmin: true, adminPermissions: ['credits:self_grant'] }, true)).toBe(false);
    expect(isHeldSelfGrant({ id: LISTED, isAdmin: true, roleAdminPermissions: ['credits:self_grant'] }, true)).toBe(
      false
    );
  });

  it('holds an unlisted admin even when they hold credits:self_grant', () => {
    expect(isHeldSelfGrant({ id: 'a', isAdmin: true, adminPermissions: ['credits:self_grant'] }, true)).toBe(true);
  });

  it('never holds a grant to someone else', () => {
    expect(isHeldSelfGrant({ id: 'a', isAdmin: true }, false)).toBe(false);
  });

  it('holds an impersonated actor granting to themselves even when the account holds credits:self_grant', () => {
    const actor = { id: LISTED, isAdmin: true, adminPermissions: ['credits:self_grant'], impersonatedBy: 'b' };
    expect(isHeldSelfGrant(actor, true)).toBe(true);
  });

  it('does not hold an impersonated actor granting to someone else', () => {
    const actor = { id: 'a', isAdmin: true, adminPermissions: ['credits:self_grant'], impersonatedBy: 'b' };
    expect(isHeldSelfGrant(actor, false)).toBe(false);
  });
});

describe('SELF_GRANT_APPROVAL', () => {
  it('asks for credits:approve_self_grant without requiring a full admin', () => {
    expect(SELF_GRANT_APPROVAL).toEqual({ requiredPermission: 'credits:approve_self_grant', requiresFullAdmin: false });
  });
});

describe('isApprovedSelfGrant', () => {
  const approvalWith = (requiredPermission: string, requester = { id: 'req', selfIds: ['req', 'alt'] }) =>
    ({ requiredPermission, requestedBy: requester }) as unknown as AdminApproval;
  const SELF = 'credits:approve_self_grant';

  it('is true when a target is the requester', () => {
    expect(isApprovedSelfGrant(approvalWith(SELF), ['x', 'req'])).toBe(true);
  });

  it('is true when a target is one of the requester selfIds', () => {
    expect(isApprovedSelfGrant(approvalWith(SELF), ['alt'])).toBe(true);
  });

  it('is false when no target is the requester', () => {
    expect(isApprovedSelfGrant(approvalWith(SELF), ['x', 'y'])).toBe(false);
  });

  it('is false for an ordinary credit approval', () => {
    expect(isApprovedSelfGrant(approvalWith('credits:adjust'), ['req'])).toBe(false);
  });

  it('is false when the executor runs without an approval', () => {
    expect(isApprovedSelfGrant(undefined, ['req'])).toBe(false);
  });
});
