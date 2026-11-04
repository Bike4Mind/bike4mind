import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  findUserByStripeCustomerId: vi.fn(),
  findOrgByStripeCustomerId: vi.fn(),
  findByStripeSubscriptionId: vi.fn(),
  emitMetric: vi.fn(),
  retrieveCharge: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  billingEventRepository: { record: mocks.record },
  userRepository: { findByStripeCustomerId: mocks.findUserByStripeCustomerId },
  organizationRepository: { findByStripeCustomerId: mocks.findOrgByStripeCustomerId },
}));
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({
  subscriptionRepository: { findByStripeSubscriptionId: mocks.findByStripeSubscriptionId },
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { STAGE: 'test' } }));
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({ emitMetric: mocks.emitMetric }));
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  stripe: { charges: { retrieve: mocks.retrieveCharge } },
}));

import { projectStripeEvent, recordBillingEvent, type StripeEventLike } from './billingEventStore';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Parameters<
  typeof recordBillingEvent
>[2];

const CREATED = Date.UTC(2026, 9, 1) / 1000;

const subscriptionUpdated = (stage: string | null = 'test'): StripeEventLike => ({
  id: 'evt_upd',
  type: 'customer.subscription.updated',
  created: CREATED,
  data: {
    object: {
      id: 'sub_1',
      object: 'subscription',
      customer: 'cus_1',
      status: 'active',
      currency: 'usd',
      cancel_at_period_end: false,
      metadata: stage ? { stage, userId: 'user_1' } : {},
      items: { data: [{ price: { id: 'price_team' }, quantity: 7 }] },
      default_payment_method: { id: 'pm_1', card: { last4: '4242', brand: 'visa', exp_year: 2030 } },
    },
    previous_attributes: { items: { data: [{ price: { id: 'price_pro' }, quantity: 5 }] } },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.record.mockResolvedValue(true);
  mocks.findByStripeSubscriptionId.mockResolvedValue(null);
  mocks.findUserByStripeCustomerId.mockResolvedValue(null);
  mocks.findOrgByStripeCustomerId.mockResolvedValue(null);
  mocks.retrieveCharge.mockResolvedValue({ customer: 'cus_1' });
});

describe('recordBillingEvent', () => {
  it('stores a plan and seat change with the owner from the subscription row', async () => {
    mocks.findByStripeSubscriptionId.mockResolvedValue({
      ownerType: SubscriptionOwnerType.Organization,
      ownerId: 'org_1',
    });

    await expect(recordBillingEvent(subscriptionUpdated(), {}, logger)).resolves.toBe('recorded');

    expect(mocks.record).toHaveBeenCalledExactlyOnceWith({
      stripeEventId: 'evt_upd',
      type: 'customer.subscription.updated',
      ownerType: 'organization',
      ownerId: 'org_1',
      subscriptionId: 'sub_1',
      amount: null,
      currency: 'usd',
      occurredAt: new Date('2026-10-01T00:00:00Z'),
      data: {
        objectId: 'sub_1',
        status: 'active',
        priceId: 'price_team',
        previousPriceId: 'price_pro',
        quantity: 7,
        previousQuantity: 5,
        cancelAtPeriodEnd: false,
      },
    });
  });

  it("never stores another stage's event, and looks nothing up for it", async () => {
    await expect(recordBillingEvent(subscriptionUpdated('prod'), {}, logger)).resolves.toBe('foreign_stage');

    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.findByStripeSubscriptionId).not.toHaveBeenCalled();
  });

  it('stores an unstamped event only when this stage has an owner for it', async () => {
    await expect(recordBillingEvent(subscriptionUpdated(null), {}, logger)).resolves.toBe('unowned');
    expect(mocks.record).not.toHaveBeenCalled();

    mocks.findUserByStripeCustomerId.mockResolvedValue({ id: 'user_9' });
    await expect(recordBillingEvent(subscriptionUpdated(null), {}, logger)).resolves.toBe('recorded');
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ ownerType: 'user', ownerId: 'user_9' }));
  });

  it('falls back to the owner in the subscription metadata for a stamped event with no row yet', async () => {
    await recordBillingEvent({ ...subscriptionUpdated(), type: 'customer.subscription.created' }, {}, logger);

    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'customer.subscription.created', ownerType: 'user', ownerId: 'user_1' })
    );
  });

  it('takes the owner and extra data the webhook branch resolved', async () => {
    const dispute: StripeEventLike = {
      id: 'evt_dp',
      type: 'charge.dispute.created',
      created: CREATED,
      data: {
        object: {
          id: 'dp_1',
          object: 'dispute',
          amount: 3000,
          currency: 'usd',
          reason: 'fraudulent',
          status: 'needs_response',
          charge: 'ch_1',
          payment_intent: 'pi_1',
          evidence: { customer_name: 'Someone', billing_address: '1 Main St' },
        },
      },
    };

    await recordBillingEvent(dispute, { owner: { ownerType: 'user', ownerId: 'user_1' } }, logger);

    expect(mocks.findUserByStripeCustomerId).not.toHaveBeenCalled();
    expect(mocks.retrieveCharge).not.toHaveBeenCalled();
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerType: 'user',
        ownerId: 'user_1',
        subscriptionId: null,
        amount: 3000,
        data: {
          objectId: 'dp_1',
          disputeId: 'dp_1',
          chargeId: 'ch_1',
          paymentIntentId: 'pi_1',
          status: 'needs_response',
          reason: 'fraudulent',
        },
      })
    );
  });

  it('reports a redelivered event as a duplicate', async () => {
    mocks.record.mockResolvedValue(false);
    await expect(recordBillingEvent(subscriptionUpdated(), {}, logger)).resolves.toBe('duplicate');
  });

  it.each([
    ['charge.dispute.closed', 'dispute', 'lost', 'user'],
    ['charge.dispute.closed', 'dispute', 'won', 'organization'],
    ['radar.early_fraud_warning.created', 'radar.early_fraud_warning', undefined, 'user'],
  ] as const)('resolves %s (%s, %s) through the charge to its %s owner', async (type, object, status, ownerType) => {
    if (ownerType === 'user') mocks.findUserByStripeCustomerId.mockResolvedValue({ id: 'owner_1' });
    else mocks.findOrgByStripeCustomerId.mockResolvedValue({ id: 'owner_1' });

    await expect(
      recordBillingEvent(
        {
          id: 'evt_charge_linked',
          type,
          created: CREATED,
          data: { object: { id: 'obj_1', object, charge: 'ch_1', status } },
        },
        {},
        logger
      )
    ).resolves.toBe('recorded');

    expect(mocks.retrieveCharge).toHaveBeenCalledExactlyOnceWith('ch_1');
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ ownerType, ownerId: 'owner_1' }));
  });

  it('does not store a charge-linked event with no owner in this stage', async () => {
    await expect(
      recordBillingEvent(
        {
          id: 'evt_foreign_dispute',
          type: 'charge.dispute.closed',
          created: CREATED,
          data: { object: { id: 'dp_1', object: 'dispute', charge: 'ch_1', status: 'lost' } },
        },
        {},
        logger
      )
    ).resolves.toBe('unowned');
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('logs charge lookup failures without failing the webhook delivery', async () => {
    mocks.retrieveCharge.mockRejectedValueOnce(new Error('Stripe unavailable'));
    await expect(
      recordBillingEvent(
        {
          id: 'evt_lookup_failed',
          type: 'charge.dispute.closed',
          created: CREATED,
          data: { object: { id: 'dp_1', object: 'dispute', charge: 'ch_1', status: 'lost' } },
        },
        {},
        logger
      )
    ).resolves.toBe('failed');
    expect(logger.error).toHaveBeenCalledWith('Failed to store billing event evt_lookup_failed', expect.anything());
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('never throws when the write fails, and alerts on it', async () => {
    mocks.record.mockRejectedValue(new Error('mongo down'));

    await expect(recordBillingEvent(subscriptionUpdated(), {}, logger)).resolves.toBe('failed');
    expect(mocks.emitMetric).toHaveBeenCalledWith('Lumina5/Billing', 'BillingEventRecordFailed', 1, {
      type: 'customer.subscription.updated',
    });
  });
});

describe('projectStripeEvent', () => {
  it('reads an invoice under the Basil parent shape, with its stage and amount due on a failure', () => {
    const projection = projectStripeEvent({
      id: 'evt_inv',
      type: 'invoice.payment_failed',
      created: CREATED,
      data: {
        object: {
          id: 'in_1',
          object: 'invoice',
          customer: 'cus_1',
          amount_due: 1900,
          amount_paid: 0,
          currency: 'usd',
          status: 'open',
          billing_reason: 'subscription_cycle',
          attempt_count: 2,
          parent: { subscription_details: { subscription: 'sub_1', metadata: { stage: 'test' } } },
          customer_address: { line1: '1 Main St' },
        },
      },
    });

    expect(projection).toEqual({
      subscriptionId: 'sub_1',
      customerId: 'cus_1',
      stage: 'test',
      metadataOwner: null,
      amount: 1900,
      currency: 'usd',
      data: {
        objectId: 'in_1',
        invoiceId: 'in_1',
        status: 'open',
        billingReason: 'subscription_cycle',
        attemptCount: 2,
      },
    });
  });

  it('keeps refund ids and the refunded amount of a charge, and no card data', () => {
    const projection = projectStripeEvent({
      id: 'evt_ch',
      type: 'charge.refunded',
      created: CREATED,
      data: {
        object: {
          id: 'ch_1',
          object: 'charge',
          customer: 'cus_1',
          amount: 5000,
          amount_refunded: 2000,
          currency: 'usd',
          status: 'succeeded',
          payment_intent: 'pi_1',
          payment_method: 'pm_1',
          payment_method_details: { card: { last4: '4242', brand: 'visa', fingerprint: 'fp_1' } },
          billing_details: { name: 'Someone', email: 'someone@example.com' },
          refunds: { data: [{ id: 're_1' }, { id: 're_2' }] },
        },
      },
    });

    expect(projection.amount).toBe(2000);
    expect(projection.data).toEqual({
      objectId: 'ch_1',
      chargeId: 'ch_1',
      paymentIntentId: 'pi_1',
      status: 'succeeded',
      refundIds: ['re_1', 're_2'],
    });
    const stored = JSON.stringify(projection);
    for (const secret of ['4242', 'visa', 'fp_1', 'pm_1', 'someone@example.com']) {
      expect(stored).not.toContain(secret);
    }
  });

  it('stores no refund ids for a charge with an empty refund list', () => {
    const projection = projectStripeEvent({
      id: 'evt_charge_2',
      type: 'charge.refunded',
      created: 1_700_000_000,
      data: { object: { id: 'ch_2', object: 'charge', amount_refunded: 0, refunds: { data: [] } } },
    });
    expect(projection.data).not.toHaveProperty('refundIds');
  });

  it('copies no payment method from a subscription', () => {
    const stored = JSON.stringify(projectStripeEvent(subscriptionUpdated()));
    expect(stored).not.toContain('4242');
    expect(stored).not.toContain('pm_1');
  });

  it("reads a credit pack's environment as its stage", () => {
    const projection = projectStripeEvent({
      id: 'evt_pi',
      type: 'payment_intent.succeeded',
      created: CREATED,
      data: {
        object: {
          id: 'pi_1',
          object: 'payment_intent',
          amount: 1000,
          amount_received: 1000,
          currency: 'usd',
          status: 'succeeded',
          metadata: { environment: 'other', userId: 'user_1', credits: '100' },
        },
      },
    });

    expect(projection.stage).toBe('other');
    expect(projection.metadataOwner).toEqual({ ownerType: 'user', ownerId: 'user_1' });
  });
});
