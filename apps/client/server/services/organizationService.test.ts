import { describe, it, expect, vi, beforeEach } from 'vitest';
import { organizationRepository, inviteRepository } from '@bike4mind/database';
import { subscriptionRepository } from '@server/models/Subscription';
import {
  validateSeatChange,
  setSeats,
  pickPrimarySubscription,
  resolveSubscriptionSource,
} from './organizationService';
import { SubscriptionSource } from '@client/lib/subscriptions/types';

// Vitest hoists vi.mock() calls above imports, so the mocked modules win
// even though imports appear higher in source order.
vi.mock('@bike4mind/database', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  return {
    ...actual,
    organizationRepository: {
      findById: vi.fn(),
      update: vi.fn(),
    },
    inviteRepository: {
      findAllByDocumentId: vi.fn().mockResolvedValue([]),
    },
    // setSeats now wraps its writes in withTransaction; in tests there's no
    // mongoose connection, so stub it to run the callback inline.
    withTransaction: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn({})),
  };
});

vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: {
    findActiveSubscriptionsByOwner: vi.fn(),
    updateByStripeSubscriptionId: vi.fn(),
    update: vi.fn(),
  },
  Subscription: {},
}));

const orgFixture = (overrides: Partial<{ id: string; seats: number; users: { userId: string }[] }> = {}) => ({
  id: overrides.id ?? 'org1',
  seats: overrides.seats ?? 4,
  users: overrides.users ?? [{ userId: 'u2' }, { userId: 'u3' }], // 2 members + 1 owner = team size 3
});

describe('organizationService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: no pending invites. Individual tests can override via mockResolvedValueOnce.
    (inviteRepository.findAllByDocumentId as any).mockResolvedValue([]);
  });

  describe('validateSeatChange', () => {
    it('rejects below stripe minimum (4) for stripe actor', () => {
      expect(() => validateSeatChange({ users: [] } as any, 3, { type: 'stripe' })).toThrow(
        /Minimum required seats: 4/
      );
    });

    it('allows 1 seat for admin actor when no members', () => {
      expect(() => validateSeatChange({ users: [] } as any, 1, { type: 'admin', userId: 'a1' })).not.toThrow();
    });

    it('rejects dropping below current team size', () => {
      // owner + 4 members = team size 5
      const org = { users: Array.from({ length: 4 }, (_, i) => ({ userId: `m${i}` })) } as any;
      expect(() => validateSeatChange(org, 4, { type: 'admin', userId: 'a1' })).toThrow(/Minimum required seats: 5/);
    });

    it('rejects exceeding ORGANIZATION_SUBSCRIPTION_MAX_SEATS', () => {
      expect(() => validateSeatChange({ users: [] } as any, 9999, { type: 'admin', userId: 'a1' })).toThrow(
        /cannot exceed/i
      );
    });

    it('accepts a valid stripe-path change', () => {
      const org = { users: [{ userId: 'm1' }, { userId: 'm2' }] } as any;
      expect(() => validateSeatChange(org, 6, { type: 'stripe' })).not.toThrow();
    });

    it('counts pending invites toward the team-size floor', () => {
      // Owner only in users[], but 4 outstanding invites - team size should be 5.
      // Without this guard, an admin could reduce seats below the eventual
      // accepted team size, and later acceptances would fail with "org full".
      const org = { users: [] } as any;
      expect(() => validateSeatChange(org, 2, { type: 'admin', userId: 'a1' }, 4)).toThrow(
        /Minimum required seats: 5.*including 4 pending invites/
      );
      expect(() => validateSeatChange(org, 5, { type: 'admin', userId: 'a1' }, 4)).not.toThrow();
    });
  });

  describe('resolveSubscriptionSource', () => {
    it('returns the persisted source when set', () => {
      expect(resolveSubscriptionSource({ source: SubscriptionSource.AdminGrant })).toBe(SubscriptionSource.AdminGrant);
      expect(resolveSubscriptionSource({ source: SubscriptionSource.Stripe })).toBe(SubscriptionSource.Stripe);
    });

    it('infers admin_grant for legacy synthetic IDs when source is missing', () => {
      expect(resolveSubscriptionSource({ source: undefined as any, subscriptionId: 'admin_granted_123_abc' })).toBe(
        SubscriptionSource.AdminGrant
      );
    });

    it('defaults to stripe for pre-migration rows with a real stripe id', () => {
      expect(resolveSubscriptionSource({ source: undefined as any, subscriptionId: 'sub_xyz' })).toBe(
        SubscriptionSource.Stripe
      );
    });
  });

  describe('pickPrimarySubscription', () => {
    it('returns the Stripe-managed sub when both are active', () => {
      const stripeSub = { id: 's', source: 'stripe' as const, subscriptionId: 'sub_x' };
      const adminGrant = { id: 'a', source: 'admin_grant' as const };
      expect(pickPrimarySubscription([adminGrant as any, stripeSub as any])).toBe(stripeSub);
    });

    it('returns the admin_grant when only that exists', () => {
      const adminGrant = { id: 'a', source: 'admin_grant' as const };
      expect(pickPrimarySubscription([adminGrant as any])).toBe(adminGrant);
    });

    it('ignores Stripe rows that have no subscriptionId (incomplete state)', () => {
      const incompleteStripe = { id: 's', source: 'stripe' as const, subscriptionId: undefined };
      const adminGrant = { id: 'a', source: 'admin_grant' as const };
      expect(pickPrimarySubscription([incompleteStripe as any, adminGrant as any])).toBe(adminGrant);
    });

    it('returns null when no relevant active sub exists', () => {
      expect(pickPrimarySubscription([])).toBe(null);
    });
  });

  describe('setSeats', () => {
    it('throws when organization is missing', async () => {
      (organizationRepository.findById as any).mockResolvedValue(null);
      await expect(setSeats('missing', 4, { type: 'admin', userId: 'a1' })).rejects.toThrow(/not found/i);
    });

    it('writes org.seats and updates active stripe subscription quantity', async () => {
      const org = orgFixture({ seats: 4 });
      (organizationRepository.findById as any).mockResolvedValue(org);
      (organizationRepository.update as any).mockResolvedValue(org);
      (subscriptionRepository.findActiveSubscriptionsByOwner as any).mockResolvedValue([
        { id: 'sub1', subscriptionId: 'sub_abc', source: 'stripe' },
      ]);

      const result = await setSeats('org1', 5, { type: 'admin', userId: 'a1' });

      expect(result.seats).toBe(5);
      expect(organizationRepository.update).toHaveBeenCalledWith(expect.objectContaining({ seats: 5 }));
      expect(subscriptionRepository.updateByStripeSubscriptionId).toHaveBeenCalledWith('sub_abc', { quantity: 5 });
      expect(subscriptionRepository.update).not.toHaveBeenCalled();
    });

    it('updates an admin_grant subscription via Mongo id when no Stripe id is present', async () => {
      const org = orgFixture({ seats: 4 });
      (organizationRepository.findById as any).mockResolvedValue(org);
      (organizationRepository.update as any).mockResolvedValue(org);
      (subscriptionRepository.findActiveSubscriptionsByOwner as any).mockResolvedValue([
        { id: 'subDoc1', source: 'admin_grant' },
      ]);

      await setSeats('org1', 6, { type: 'admin', userId: 'a1' });

      expect(subscriptionRepository.update).toHaveBeenCalledWith({ id: 'subDoc1', quantity: 6 });
      expect(subscriptionRepository.updateByStripeSubscriptionId).not.toHaveBeenCalled();
    });

    it('prefers a Stripe-managed sub over an admin_grant when both are active', async () => {
      // Conversion window race: during checkout completion, both the
      // newly-created stripe sub AND the prior admin_grant can be returned
      // as "active" briefly. setSeats must mutate the Stripe row (the one
      // being billed) - picking the admin_grant would drift Stripe from DB.
      const org = orgFixture({ seats: 4 });
      (organizationRepository.findById as any).mockResolvedValue(org);
      (organizationRepository.update as any).mockResolvedValue(org);
      (subscriptionRepository.findActiveSubscriptionsByOwner as any).mockResolvedValue([
        { id: 'docA', source: 'admin_grant' },
        { id: 'docB', source: 'stripe', subscriptionId: 'sub_real_stripe' },
      ]);

      await setSeats('org1', 5, { type: 'admin', userId: 'a1' });

      expect(subscriptionRepository.updateByStripeSubscriptionId).toHaveBeenCalledWith('sub_real_stripe', {
        quantity: 5,
      });
      expect(subscriptionRepository.update).not.toHaveBeenCalled();
    });

    it('rejects a stripe-actor decrement below the Stripe minimum', async () => {
      const org = orgFixture({ seats: 5, users: [] });
      (organizationRepository.findById as any).mockResolvedValue(org);
      await expect(setSeats('org1', 3, { type: 'stripe' })).rejects.toThrow(/Minimum required seats: 4/);
      expect(organizationRepository.update).not.toHaveBeenCalled();
    });

    it('rejects a reduction that would shrink below accepted members + pending invites', async () => {
      // Owner-only org (users.length=0) with 4 pending invites. validateSeatChange
      // must read users.length + 1 + pending = 5, not 1, otherwise the next
      // invite acceptance fails with org-full.
      const org = orgFixture({ seats: 6, users: [] });
      (organizationRepository.findById as any).mockResolvedValue(org);
      (inviteRepository.findAllByDocumentId as any).mockResolvedValue([
        { recipients: { pending: ['a@x.com', 'b@x.com'] } },
        { recipients: { pending: ['c@x.com', 'd@x.com'] } },
      ]);

      await expect(setSeats('org1', 2, { type: 'admin', userId: 'a1' })).rejects.toThrow(
        /Minimum required seats: 5.*including 4 pending invites/
      );
      expect(organizationRepository.update).not.toHaveBeenCalled();
    });
  });
});
