import { describe, expect, it } from 'vitest';
import { isHeldSelfGrant } from './selfGrant';

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
