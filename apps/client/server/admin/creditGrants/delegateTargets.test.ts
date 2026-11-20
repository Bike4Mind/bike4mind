// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ findUser: vi.fn(), findOrg: vi.fn(), findUsers: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: h.findUser, find: h.findUsers },
  organizationRepository: { findById: h.findOrg },
}));

import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
import {
  assertDelegateCanChangeSubscription,
  assertDelegateCanCreditOrganization,
  assertDelegateCanCreditUser,
  assertDelegateCanCreditUsers,
} from './delegateTargets';

const delegate = { id: 'delegate-1', isAdmin: false, adminPermissions: ['credits:adjust'] };
const fullAdmin = { id: 'admin-1', isAdmin: true };

beforeEach(() => {
  h.findUsers.mockReset().mockResolvedValue([]);
  h.findUser.mockReset().mockResolvedValue({ id: 'user-1' });
  h.findOrg.mockReset().mockResolvedValue(null);
});

describe('assertDelegateCanCreditUser', () => {
  it('lets a delegate credit an ordinary account', async () => {
    await expect(assertDelegateCanCreditUser(delegate, 'user-1', 'credit')).resolves.toBeUndefined();
  });

  it('refuses a delegate crediting its own account', async () => {
    await expect(assertDelegateCanCreditUser(delegate, 'delegate-1', 'credit')).rejects.toThrow(
      'You cannot credit your own account'
    );
  });

  it('refuses a delegate crediting an account with admin access', async () => {
    h.findUser.mockResolvedValue({ id: 'user-2', isAdmin: true });
    await expect(assertDelegateCanCreditUser(delegate, 'user-2', 'credit')).rejects.toThrow(
      'Only full administrators can credit users with admin access'
    );
  });

  it('leaves full admins to the routes own self checks', async () => {
    h.findUser.mockResolvedValue({ id: 'admin-1', isAdmin: true });
    await expect(assertDelegateCanCreditUser(fullAdmin, 'admin-1', 'credit')).resolves.toBeUndefined();
    expect(h.findUser).not.toHaveBeenCalled();
  });
});

describe('assertDelegateCanCreditOrganization', () => {
  it.each([
    ['owns', { userId: 'delegate-1' }],
    ['administers', { userId: 'user-1', adminUserIds: ['delegate-1'] }],
    ['is a member of', { userId: 'user-1', users: [{ userId: 'delegate-1' }] }],
  ])('refuses a delegate that %s the organization', async (_label, organization) => {
    await expect(assertDelegateCanCreditOrganization(delegate, organization, 'top up')).rejects.toThrow(
      'You cannot top up an organization you belong to'
    );
  });

  it('refuses a delegate when the billing owner has admin access', async () => {
    h.findUser.mockResolvedValue({ id: 'user-2', adminPermissions: ['support:read'] });
    await expect(assertDelegateCanCreditOrganization(delegate, { userId: 'user-2' }, 'top up')).rejects.toThrow(
      'Only full administrators'
    );
  });

  it('lets a delegate top up an unrelated organization, and a full admin any', async () => {
    await expect(
      assertDelegateCanCreditOrganization(delegate, { userId: 'user-1', users: [] }, 'top up')
    ).resolves.toBeUndefined();
    await expect(
      assertDelegateCanCreditOrganization(fullAdmin, { userId: 'admin-1' }, 'top up')
    ).resolves.toBeUndefined();
  });
});

describe('assertDelegateCanChangeSubscription', () => {
  it('checks the owning user of a user subscription', async () => {
    await expect(
      assertDelegateCanChangeSubscription(
        delegate,
        { ownerType: SubscriptionOwnerType.User, ownerId: 'delegate-1' },
        'change'
      )
    ).rejects.toThrow('your own account');
  });

  it('checks the organization of an organization subscription', async () => {
    h.findOrg.mockResolvedValue({ userId: 'user-1', users: [{ userId: 'delegate-1' }] });
    await expect(
      assertDelegateCanChangeSubscription(
        delegate,
        { ownerType: SubscriptionOwnerType.Organization, ownerId: 'org-1' },
        'change'
      )
    ).rejects.toThrow('an organization you belong to');
  });
});

describe('bulk delegate targets', () => {
  it('loads all targets once and refuses admin-access accounts', async () => {
    h.findUsers.mockResolvedValue([{ id: 'user-1' }, { id: 'user-2', adminPermissions: ['support:read'] }]);
    await expect(assertDelegateCanCreditUsers(delegate, ['user-1', 'user-2'], 'credit')).rejects.toThrow(
      'Only full administrators'
    );
    expect(h.findUsers).toHaveBeenCalledExactlyOnceWith(
      { _id: { $in: ['user-1', 'user-2'] } },
      { isAdmin: 1, adminPermissions: 1, adminRoleIds: 1 }
    );
  });
  it('does not read targets for an empty request or full admin', async () => {
    await assertDelegateCanCreditUsers(delegate, [], 'credit');
    await assertDelegateCanCreditUsers(fullAdmin, ['user-1'], 'credit');
    expect(h.findUsers).not.toHaveBeenCalled();
  });
  it('propagates a failed target lookup', async () => {
    h.findUsers.mockRejectedValue(new Error('lookup unavailable'));
    await expect(assertDelegateCanCreditUsers(delegate, ['user-1'], 'credit')).rejects.toThrow('lookup unavailable');
  });
  it('refuses a missing organization for a delegate', async () => {
    await expect(
      assertDelegateCanChangeSubscription(
        delegate,
        { ownerType: SubscriptionOwnerType.Organization, ownerId: 'org-1' },
        'change'
      )
    ).rejects.toThrow('Organization not found');
  });
});
