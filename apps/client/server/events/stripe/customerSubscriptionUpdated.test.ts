import { describe, it, expect, vi, beforeEach } from 'vitest';
import { organizationRepository } from '@bike4mind/database';
import { setSeats } from '@server/services/organizationService';
import { emitMetric } from '@server/utils/cloudwatch';
import { stripe } from '@server/integrations/stripe/stripe';
import { sendToClient } from '@server/websocket/utils';
import { subscriptionRepository } from '@server/models/Subscription';
import { handler } from './customerSubscriptionUpdated';
import { BadRequestError } from '@bike4mind/utils';

vi.mock('@bike4mind/database', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  return {
    ...actual,
    organizationRepository: {
      findByStripeCustomerId: vi.fn(),
      update: vi.fn(),
    },
    withTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: {
    updateByStripeSubscriptionId: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('@server/services/organizationService', () => ({
  setSeats: vi.fn(),
}));

vi.mock('@server/integrations/stripe/stripe', () => ({
  stripe: {
    subscriptions: { retrieve: vi.fn() },
  },
}));

vi.mock('@server/utils/eventBus', () => ({
  StripeEvents: {
    CustomerSubscriptionUpdated: { schema: { parse: (x: unknown) => x } },
  },
}));

vi.mock('@server/websocket/utils', () => ({
  sendToClient: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@server/utils/cloudwatch', () => ({
  emitMetric: vi.fn().mockResolvedValue(undefined),
}));

// Fixtures below set metadata.stage: 'test'; pin the current stage to match so
// the stage guard falls through for same-stage events (and trips on mismatch).
vi.mock('@server/utils/config', () => ({
  Config: { STAGE: 'test' },
}));

// Fixture mapping: the real registry rows are covered by their own tests;
// here we only need "mapped" vs "unmapped" prices.
vi.mock('@client/lib/entitlements/registry', () => ({
  entitlementsForPriceIds: (priceIds: string[]) => new Set(priceIds.includes('price_pro') ? ['someproduct:pro'] : []),
}));

vi.mock('sst', () => ({
  Resource: { websocket: { managementEndpoint: 'ws://test' } },
}));

vi.mock('../utils', () => ({
  withEventContext: (h: any) => h,
}));

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const buildStripeSub = (quantity: number) => ({
  id: 'sub_stripe_a',
  status: 'active',
  canceled_at: null,
  customer: 'cus_a',
  metadata: {
    userId: 'u1',
    stage: 'test',
    ownerType: 'Organization',
    organizationId: 'org-a',
  },
  items: {
    data: [
      {
        quantity,
        price: { id: 'price_org' },
        current_period_start: 1700000000,
        current_period_end: 1702592000,
      },
    ],
  },
});

describe('customerSubscriptionUpdated — resilient seat sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('force-syncs org.seats when setSeats validation rejects, to avoid Stripe/DB drift', async () => {
    (stripe.subscriptions.retrieve as any).mockResolvedValue(buildStripeSub(3));
    const org = { id: 'org-a', seats: 5, users: [] };
    (organizationRepository.findByStripeCustomerId as any).mockResolvedValue(org);

    // Simulate setSeats throwing because team-size floor / platform min fails.
    (setSeats as any).mockRejectedValue(new BadRequestError('Minimum required seats: 4'));

    await handler({ properties: { subscriptionId: 'sub_stripe_a' } } as any, logger as any);

    // Despite the validation failure, we must reflect Stripe's quantity locally.
    expect(organizationRepository.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'org-a', seats: 3 }));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Force-syncing'));
  });

  it('does not force-write when setSeats succeeds', async () => {
    (stripe.subscriptions.retrieve as any).mockResolvedValue(buildStripeSub(6));
    const org = { id: 'org-a', seats: 4, users: [] };
    (organizationRepository.findByStripeCustomerId as any).mockResolvedValue(org);
    (setSeats as any).mockResolvedValue(org);

    await handler({ properties: { subscriptionId: 'sub_stripe_a' } } as any, logger as any);

    expect(organizationRepository.update).not.toHaveBeenCalled();
    expect(setSeats).toHaveBeenCalledWith('org-a', 6, { type: 'stripe' });
  });
});

const buildUserSub = (overrides: { priceId?: string; status?: string; metadata?: Record<string, string> } = {}) => ({
  id: 'sub_stripe_u',
  status: overrides.status ?? 'active',
  canceled_at: null,
  customer: 'cus_u',
  metadata: overrides.metadata ?? {
    userId: 'u1',
    stage: 'test',
    ownerType: 'User',
  },
  items: {
    data: [
      {
        quantity: 1,
        price: { id: overrides.priceId ?? 'price_pro' },
        current_period_start: 1700000000,
        current_period_end: 1702592000,
      },
    ],
  },
});

const entitlementsPush = (userId: string) => [
  userId,
  'ws://test',
  { action: 'invalidate_query', queryKey: ['entitlements'] },
];

describe('customerSubscriptionUpdated — entitlement reconcile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pushes an entitlements invalidation to the owner when the price is entitlement-mapped', async () => {
    (stripe.subscriptions.retrieve as any).mockResolvedValue(buildUserSub());

    await handler({ properties: { subscriptionId: 'sub_stripe_u' } } as any, logger as any);

    expect(sendToClient).toHaveBeenCalledWith(...entitlementsPush('u1'));
    expect(emitMetric).toHaveBeenCalledWith(
      'Lumina5/Entitlements',
      'EntitlementReconciled',
      1,
      expect.objectContaining({ priceId: 'price_pro', status: 'active' })
    );
  });

  it('also fires on a revoking transition (canceled) — gates must learn about access loss', async () => {
    (stripe.subscriptions.retrieve as any).mockResolvedValue(buildUserSub({ status: 'canceled' }));

    await handler({ properties: { subscriptionId: 'sub_stripe_u' } } as any, logger as any);

    expect(sendToClient).toHaveBeenCalledWith(...entitlementsPush('u1'));
  });

  it('does not push entitlements for an unmapped price (no-op for non-entitlement products)', async () => {
    (stripe.subscriptions.retrieve as any).mockResolvedValue(buildUserSub({ priceId: 'price_other' }));

    await handler({ properties: { subscriptionId: 'sub_stripe_u' } } as any, logger as any);

    expect(sendToClient).not.toHaveBeenCalledWith(...entitlementsPush('u1'));
    expect(emitMetric).not.toHaveBeenCalled();
  });

  it('never calls sendToClient with a falsy userId (legacy metadata) — would broadcast to every connection', async () => {
    (stripe.subscriptions.retrieve as any).mockResolvedValue(
      buildUserSub({ metadata: { stage: 'test', ownerType: 'User' } })
    );

    await handler({ properties: { subscriptionId: 'sub_stripe_u' } } as any, logger as any);

    expect(sendToClient).not.toHaveBeenCalled();
    expect(emitMetric).toHaveBeenCalledWith(
      'Lumina5/Entitlements',
      'EntitlementSkipped',
      1,
      expect.objectContaining({ reason: 'missing_user_id' })
    );
  });

  it('skips the entitlements push for org-owned subscriptions (seat fan-out deferred)', async () => {
    (stripe.subscriptions.retrieve as any).mockResolvedValue({
      ...buildStripeSub(4),
      items: { data: [{ ...buildStripeSub(4).items.data[0], price: { id: 'price_pro' } }] },
    });
    (organizationRepository.findByStripeCustomerId as any).mockResolvedValue({ id: 'org-a', seats: 4, users: [] });
    (setSeats as any).mockResolvedValue({});

    await handler({ properties: { subscriptionId: 'sub_stripe_a' } } as any, logger as any);

    expect(sendToClient).not.toHaveBeenCalledWith(...entitlementsPush('u1'));
    expect(emitMetric).toHaveBeenCalledWith(
      'Lumina5/Entitlements',
      'EntitlementSkipped',
      1,
      expect.objectContaining({ reason: 'org_owner_fanout_deferred' })
    );
  });

  it('sends exactly one push per delivery and does not throw on re-delivery (at-least-once semantics)', async () => {
    (stripe.subscriptions.retrieve as any).mockResolvedValue(buildUserSub());

    await handler({ properties: { subscriptionId: 'sub_stripe_u' } } as any, logger as any);
    await handler({ properties: { subscriptionId: 'sub_stripe_u' } } as any, logger as any);

    const entitlementCalls = (sendToClient as any).mock.calls.filter(
      (call: unknown[]) =>
        JSON.stringify(call[2]) === JSON.stringify({ action: 'invalidate_query', queryKey: ['entitlements'] })
    );
    expect(entitlementCalls).toHaveLength(2);
  });
});

describe('customerSubscriptionUpdated — stage guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips (no DB write, no push) when metadata.stage does not match the current stage', async () => {
    (stripe.subscriptions.retrieve as any).mockResolvedValue(
      buildUserSub({ metadata: { userId: 'u1', stage: 'production', ownerType: 'User' } })
    );

    await handler({ properties: { subscriptionId: 'sub_stripe_u' } } as any, logger as any);

    expect(subscriptionRepository.updateByStripeSubscriptionId).not.toHaveBeenCalled();
    expect(sendToClient).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('does not match current stage'));
    expect(emitMetric).toHaveBeenCalledWith(
      'Lumina5/Entitlements',
      'EntitlementSkipped',
      1,
      expect.objectContaining({ reason: 'stage_mismatch' })
    );
  });

  it('processes normally when metadata.stage is absent (legacy subs fall through)', async () => {
    (stripe.subscriptions.retrieve as any).mockResolvedValue(
      buildUserSub({ metadata: { userId: 'u1', ownerType: 'User' } })
    );

    await handler({ properties: { subscriptionId: 'sub_stripe_u' } } as any, logger as any);

    expect(subscriptionRepository.updateByStripeSubscriptionId).toHaveBeenCalled();
    expect(sendToClient).toHaveBeenCalledWith(...entitlementsPush('u1'));
  });
});
