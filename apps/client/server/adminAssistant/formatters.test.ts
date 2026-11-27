import { describe, expect, it } from 'vitest';
import { orgRoleOf } from './formatters';

describe('orgRoleOf', () => {
  const org = {
    userId: 'owner',
    adminUserIds: ['owner', 'manager', 'both', 'stale-manager'],
    billingManagerUserIds: ['owner', 'billing', 'both', 'stale-billing'],
    users: ['manager', 'billing', 'both', 'member'].map(userId => ({ userId })),
  };

  it.each([
    ['owner', 'owner'],
    ['manager', 'admin'],
    ['billing', 'billingManager'],
    ['both', 'admin'],
    ['member', 'member'],
    ['stale-manager', 'member'],
    ['stale-billing', 'member'],
    ['outsider', 'member'],
  ])('formats %s as %s', (userId, expected) => {
    expect(orgRoleOf(org, userId)).toBe(expected);
  });

  it('handles legacy documents without role lists', () => {
    expect(orgRoleOf({ userId: 'owner' }, 'owner')).toBe('owner');
    expect(orgRoleOf({ userId: 'owner' }, 'other')).toBe('member');
  });
});
