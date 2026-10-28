import { describe, it, expect, vi, beforeEach } from 'vitest';
import { organizationRepository } from '@bike4mind/database';
import { setSeats } from '@server/services/organizationService';
import { emitMetric } from '@bike4mind/server-utils/utils/cloudwatch';
import { stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import { voidOpenSubscriptionInvoices } from '@server/integrations/stripe/dunning';
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
    updateByStripeSubscriptionIdReturningBefore: vi.fn().mockResolvedValue({}),
  },
}));

// The lifecycle events' own rules are covered in signupEvents.test.ts and
// billingEventDetails.test.ts; here only which events this handler sends.
const { mockEmitBillingEvent, mockSubscriptionEventUser } = vi.hoisted(() => ({
  mockEmitBillingEvent: vi.fn(),
  mockSubscriptionEventUser: vi.fn(),
}));
vi.mock('@server/analytics/signupEvents', () => ({ emitBillingEvent: mockEmitBillingEvent }));
vi.mock('@server/analytics/billingEventDetails', () => ({
  planDetails: (priceId: string) => ({ plan: `plan:${priceId}`, interval: 'monthly' }),
  planChangeDirection: () => 'upgrade',
  rowTimestamps: (row: { updatedAt?: Date }) => ({ updatedAt: row.updatedAt }),
  subscriptionEventUser: mockSubscriptionEventUser,
}));

vi.mock('@server/services/organizationService', () => ({
  setSeats: vi.fn(),
}));

vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  stripe: {
    subscriptions: { retrieve: vi.fn() },
  },
}));

vi.mock('@server/integrations/stripe/dunning', () => ({
  voidOpenSubscriptionInvoices: vi.fn().mockResolvedValue({ voided: [], failed: [] }),
}));

vi.mock('@server/utils/eventBus', () => ({
  StripeEvents: {
    CustomerSubscriptionUpdated: { schema: { parse: (x: unknown) => x } },
  },
}));

vi.mock('@server/websocket/utils', () => ({
  sendToClient: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({
  emitMetric: vi.fn().mockResolvedValue(undefined),
}));

// Fixtures below set metadata.stage: 'test'; pin the current stage to match so
// the stage guard falls through for same-stage events (and trips on mismatch).
vi.mock('@bike4mind/server-utils/utils/config', () => ({
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

vi.mock('@workers/utils/eventContext', () => ({
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
    expect(organizationRepository.update).toHaveBeenCalledWith({ id: 'org-a', seats: 3 });
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

const buildUserSub = (
  overrides: {
    priceId?: string;
    status?: string;
    metadata?: Record<string, string>;
    cancelAtPeriodEnd?: boolean;
    canceledAt?: number | null;
  } = {}
) => ({
  id: 'sub_stripe_u',
  status: overrides.status ?? 'active',
  cancel_at_period_end: overrides.cancelAtPeriodEnd ?? false,
  canceled_at: overrides.canceledAt ?? null,
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
        // Deliberately distinct from the `canceled_at` literals the cancel-path tests
        // use: those assert the cutoff came from canceled_at, and an equal
        // current_period_start would let the wrong source pass.
        current_period_start: 1699999000,
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

    expect(subscriptionRepository.updateByStripeSubscriptionIdReturningBefore).not.toHaveBeenCalled();
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

    expect(subscriptionRepository.updateByStripeSubscriptionIdReturningBefore).toHaveBeenCalled();
    expect(sendToClient).toHaveBeenCalledWith(...entitlementsPush('u1'));
  });

  it('mirrors price, currency, interval, cancel state, trial end and customer onto the row', async () => {
    (stripe.subscriptions.retrieve as any).mockResolvedValue({
      ...buildUserSub({ cancelAtPeriodEnd: true }),
      cancel_at: 1702592000,
      currency: 'usd',
      trial_end: 1700604800,
      items: {
        data: [
          {
            ...buildUserSub().items.data[0],
            price: {
              id: 'price_pro',
              unit_amount: 2000,
              currency: 'usd',
              recurring: { interval: 'month', interval_count: 1 },
            },
          },
        ],
      },
    });

    await handler({ properties: { subscriptionId: 'sub_stripe_u' } } as any, logger as any);

    expect(subscriptionRepository.updateByStripeSubscriptionIdReturningBefore).toHaveBeenCalledWith(
      'sub_stripe_u',
      expect.objectContaining({
        priceId: 'price_pro',
        unitAmount: 2000,
        currency: 'usd',
        interval: 'month',
        intervalCount: 1,
        cancelAtPeriodEnd: true,
        cancelAt: new Date(1702592000 * 1000),
        trialEndsAt: new Date(1700604800 * 1000),
        stripeCustomerId: 'cus_u',
        lastSyncedAt: expect.any(Date),
      })
    );
  });
});

describe('customerSubscriptionUpdated - stops dunning on a cancel Stripe recorded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // vi.clearAllMocks keeps implementations, so re-arm the default after any
    // test that made the helper reject.
    (voidOpenSubscriptionInvoices as any).mockResolvedValue({ voided: [], failed: [] });
  });

  it('voids the open invoices when cancel_at_period_end is set (Billing Portal cancel)', async () => {
    // The reported path: the customer cancels in Stripe's hosted portal, so the
    // only signal our code gets is this event. The open invoice would otherwise
    // keep retrying and keep emailing.
    (stripe.subscriptions.retrieve as any).mockResolvedValue(
      buildUserSub({ cancelAtPeriodEnd: true, canceledAt: 1700000000 })
    );

    await handler({ properties: { subscriptionId: 'sub_stripe_u' } } as any, logger as any);

    // Bounded to what existed when the cancel was requested: this event fires again
    // on every later update, and a proration invoice from a legitimate change made
    // during the pending-cancellation window must not be swept up with the stale one.
    expect(voidOpenSubscriptionInvoices).toHaveBeenCalledWith('sub_stripe_u', { createdBefore: 1700000000 });
  });

  it('voids the open invoices when the subscription arrives already canceled', async () => {
    (stripe.subscriptions.retrieve as any).mockResolvedValue(
      buildUserSub({ status: 'canceled', canceledAt: 1700000000 })
    );

    await handler({ properties: { subscriptionId: 'sub_stripe_u' } } as any, logger as any);

    expect(voidOpenSubscriptionInvoices).toHaveBeenCalledWith('sub_stripe_u', { createdBefore: 1700000000 });
  });

  it('does not touch invoices on a routine update', async () => {
    (stripe.subscriptions.retrieve as any).mockResolvedValue(buildUserSub());

    await handler({ properties: { subscriptionId: 'sub_stripe_u' } } as any, logger as any);

    expect(voidOpenSubscriptionInvoices).not.toHaveBeenCalled();
  });

  it('does not void invoices for a subscription this stage has no row for', async () => {
    // A Dashboard-created subscription, or the same event delivered to another
    // stage's endpoint: the status sync is a no-op, and the void is irreversible, so
    // the ownership check has to fail closed. The `deleted` branch in
    // pages/api/stripe/webhook.ts guards the identical call the same way.
    (stripe.subscriptions.retrieve as any).mockResolvedValue(
      buildUserSub({ status: 'canceled', canceledAt: 1700000000 })
    );
    (subscriptionRepository.updateByStripeSubscriptionIdReturningBefore as any).mockResolvedValueOnce(null);

    await handler({ properties: { subscriptionId: 'sub_stripe_u' } } as any, logger as any);

    expect(voidOpenSubscriptionInvoices).not.toHaveBeenCalled();
    expect(emitMetric).not.toHaveBeenCalledWith('Lumina5/Entitlements', 'DunningCleanupFailed', 1, expect.anything());
  });

  it('still completes the status sync when the invoice cleanup fails', async () => {
    (stripe.subscriptions.retrieve as any).mockResolvedValue(buildUserSub({ cancelAtPeriodEnd: true }));
    (voidOpenSubscriptionInvoices as any).mockRejectedValue(new Error('stripe unavailable'));

    await handler({ properties: { subscriptionId: 'sub_stripe_u' } } as any, logger as any);

    expect(subscriptionRepository.updateByStripeSubscriptionIdReturningBefore).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
    expect(emitMetric).toHaveBeenCalledWith('Lumina5/Entitlements', 'DunningCleanupFailed', 1, {
      reason: 'void_failed',
    });
  });

  it('reports per-invoice void failures without breaking the status sync', async () => {
    (stripe.subscriptions.retrieve as any).mockResolvedValue(buildUserSub({ cancelAtPeriodEnd: true }));
    (voidOpenSubscriptionInvoices as any).mockResolvedValue({ voided: ['in_a'], failed: ['in_b'] });

    await handler({ properties: { subscriptionId: 'sub_stripe_u' } } as any, logger as any);

    expect(subscriptionRepository.updateByStripeSubscriptionIdReturningBefore).toHaveBeenCalled();
    expect(emitMetric).toHaveBeenCalledWith('Lumina5/Entitlements', 'DunningCleanupFailed', 1, {
      reason: 'void_failed',
    });
  });
});

describe('customerSubscriptionUpdated - lifecycle events', () => {
  const payer = { id: 'u1', acquisition: { firstTouch: { source: 'widgets' } } };
  const rowBefore = (over: Record<string, unknown> = {}) => ({
    ownerType: 'User',
    ownerId: 'u1',
    status: 'active',
    priceId: 'price_basic',
    canceledAt: null,
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...over,
  });
  const userSub = (over: Record<string, unknown> = {}) => ({
    ...buildStripeSub(1),
    metadata: { userId: 'u1', stage: 'test', ownerType: 'User' },
    items: {
      data: [
        { quantity: 1, price: { id: 'price_basic' }, current_period_start: 1700000000, current_period_end: 1702592000 },
      ],
    },
    ...over,
  });
  const run = () => handler({ properties: { subscriptionId: 'sub_stripe_a' } } as any, logger as any);
  const sentEvents = () => mockEmitBillingEvent.mock.calls.map(([c]) => c.event);

  // The row the handler's own write replaced, which is what it compares Stripe's state against.
  const writeFinds = (row: Record<string, unknown> | null) =>
    (subscriptionRepository.updateByStripeSubscriptionIdReturningBefore as any).mockResolvedValue(row);

  beforeEach(() => {
    vi.clearAllMocks();
    (voidOpenSubscriptionInvoices as any).mockResolvedValue({ voided: [], failed: [] });
    writeFinds(rowBefore());
    mockSubscriptionEventUser.mockResolvedValue(payer);
  });

  it('sends plan_changed when the price moves, naming both plans and keyed on the row version', async () => {
    writeFinds(rowBefore());
    const sub = userSub();
    sub.items.data[0].price.id = 'price_pro';
    (stripe.subscriptions.retrieve as any).mockResolvedValue(sub);

    await run();

    expect(mockEmitBillingEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitBillingEvent).toHaveBeenCalledWith({
      user: payer,
      event: 'plan_changed',
      occurrence: 'sub_stripe_a:plan:2026-10-01T00:00:00.000Z',
      metadata: {
        fromPlan: 'plan:price_basic',
        toPlan: 'plan:price_pro',
        fromInterval: 'monthly',
        toInterval: 'monthly',
        direction: 'upgrade',
      },
    });
  });

  it('sends subscription_cancel_scheduled when a period-end cancel is set', async () => {
    writeFinds(rowBefore());
    (stripe.subscriptions.retrieve as any).mockResolvedValue(
      userSub({ cancel_at_period_end: true, canceled_at: 1700500000 })
    );

    await run();

    expect(sentEvents()).toEqual(['subscription_cancel_scheduled']);
    expect(mockEmitBillingEvent.mock.calls[0][0]).toMatchObject({
      occurrence: 'sub_stripe_a:cancel:2026-10-01T00:00:00.000Z',
      metadata: { plan: 'plan:price_basic', interval: 'monthly' },
    });
  });

  it('sends subscription_cancel_reverted when that cancel is withdrawn', async () => {
    writeFinds(rowBefore({ canceledAt: new Date('2026-09-30T00:00:00Z') }));
    (stripe.subscriptions.retrieve as any).mockResolvedValue(
      userSub({ cancel_at_period_end: false, canceled_at: null })
    );

    await run();

    expect(sentEvents()).toEqual(['subscription_cancel_reverted']);
  });

  it('sends nothing on an update that repeats the state it had (a renewal)', async () => {
    writeFinds(rowBefore({ canceledAt: new Date('2026-09-30T00:00:00Z') }));
    (stripe.subscriptions.retrieve as any).mockResolvedValue(
      userSub({ cancel_at_period_end: true, canceled_at: 1700500000 })
    );

    await run();

    expect(mockEmitBillingEvent).not.toHaveBeenCalled();
  });

  it('leaves a subscription that is over to the deleted webhook', async () => {
    writeFinds(rowBefore());
    (stripe.subscriptions.retrieve as any).mockResolvedValue(userSub({ status: 'canceled', canceled_at: 1700500000 }));

    await run();

    expect(mockEmitBillingEvent).not.toHaveBeenCalled();
  });

  it('sends nothing for a subscription with no user to attribute, an organization one', async () => {
    writeFinds(rowBefore({ ownerType: 'Organization' }));
    mockSubscriptionEventUser.mockResolvedValue(null);
    const sub = userSub();
    sub.items.data[0].price.id = 'price_pro';
    (stripe.subscriptions.retrieve as any).mockResolvedValue(sub);

    await run();

    expect(mockEmitBillingEvent).not.toHaveBeenCalled();
  });

  it('sends nothing for a row this stage does not own', async () => {
    writeFinds(null);
    (stripe.subscriptions.retrieve as any).mockResolvedValue(userSub({ canceled_at: 1700500000 }));

    await run();

    expect(subscriptionRepository.updateByStripeSubscriptionIdReturningBefore).toHaveBeenCalledTimes(1);
    expect(mockEmitBillingEvent).not.toHaveBeenCalled();
  });

  it('reports one transition between two updates that race, each comparing against what the other wrote', async () => {
    // A stand-in for the atomic write: each call swaps the row and hands back the one it replaced.
    // With a read before the write, both updates would read the original row, and both report
    // the same cancel as newly scheduled.
    let row: Record<string, unknown> = rowBefore();
    let version = 0;
    (subscriptionRepository.updateByStripeSubscriptionIdReturningBefore as any).mockImplementation(
      async (_id: string, data: Record<string, unknown>) => {
        const replaced = row;
        row = { ...row, ...data, updatedAt: new Date(Date.UTC(2026, 9, 2, 0, 0, ++version)) };
        return replaced;
      }
    );
    (stripe.subscriptions.retrieve as any).mockResolvedValue(
      userSub({ cancel_at_period_end: true, canceled_at: 1700500000 })
    );

    await Promise.all([run(), run()]);

    expect(sentEvents()).toEqual(['subscription_cancel_scheduled']);
    expect(mockEmitBillingEvent.mock.calls[0][0].occurrence).toBe('sub_stripe_a:cancel:2026-10-01T00:00:00.000Z');
  });

  it('voids the open invoices before the report, so a report that never settles cannot hold them up', async () => {
    mockEmitBillingEvent.mockReturnValueOnce(new Promise(() => {}));
    (stripe.subscriptions.retrieve as any).mockResolvedValue(
      userSub({ cancel_at_period_end: true, canceled_at: 1700500000 })
    );

    // Not awaited: the handler waits on the report, which here never settles.
    void run();
    await vi.waitFor(() => expect(mockEmitBillingEvent).toHaveBeenCalled());

    expect(voidOpenSubscriptionInvoices).toHaveBeenCalledWith('sub_stripe_a', { createdBefore: 1700500000 });
  });

  it('finishes the delivery when the report rejects', async () => {
    mockEmitBillingEvent.mockRejectedValueOnce(new Error('ingest down'));
    (stripe.subscriptions.retrieve as any).mockResolvedValue(
      userSub({ cancel_at_period_end: true, canceled_at: 1700500000 })
    );

    await expect(run()).resolves.toBeUndefined();

    expect(voidOpenSubscriptionInvoices).toHaveBeenCalled();
    expect(sendToClient).toHaveBeenCalledWith('u1', 'ws://test', {
      action: 'invalidate_query',
      queryKey: ['subscriptions'],
    });
  });
});
