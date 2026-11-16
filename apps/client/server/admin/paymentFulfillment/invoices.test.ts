import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
const mocks = vi.hoisted(() => ({
  subscription: vi.fn(),
  user: vi.fn(),
  org: vi.fn(),
  payments: vi.fn(),
  intent: vi.fn(),
  find: vi.fn(),
  lean: vi.fn(),
  refunds: vi.fn(),
  disputes: vi.fn(),
  charge: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  CreditTransaction: { find: mocks.find },
  userRepository: { findByStripeCustomerId: mocks.user },
  organizationRepository: { findByStripeCustomerId: mocks.org },
}));
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({
  subscriptionRepository: { findByStripeSubscriptionId: mocks.subscription },
}));
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  stripe: {
    invoicePayments: { list: mocks.payments },
    paymentIntents: { retrieve: mocks.intent },
    charges: { retrieve: mocks.charge },
    refunds: { list: mocks.refunds },
    disputes: { list: mocks.disputes },
  },
}));
import { invoiceEvidence } from './invoices';
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { STAGE: 'test-stage' } }));
import { classifyPayment } from './classify';
const invoice = (patch: Record<string, unknown> = {}) =>
  ({
    id: 'in_one',
    created: 1700000000,
    amount_paid: 1900,
    currency: 'usd',
    livemode: false,
    status: 'paid',
    status_transitions: { paid_at: 1700000010 },
    customer: 'cus_local',
    parent: { subscription_details: { subscription: 'sub_one' } },
    billing_reason: 'subscription_cycle',
    lines: { data: [{ quantity: 1 }], has_more: false },
    ...patch,
  }) as unknown as Stripe.Invoice;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.subscription.mockResolvedValue({ id: 'local_sub', ownerType: 'User', ownerId: 'user_one' });
  mocks.user.mockResolvedValue({ id: 'user_one', isInternal: true });
  mocks.org.mockResolvedValue(null);
  mocks.payments.mockResolvedValue({
    data: [{ payment: { type: 'payment_intent', payment_intent: 'pi_one' } }],
    has_more: false,
  });
  mocks.intent.mockResolvedValue({ latest_charge: { id: 'ch_one', amount_refunded: 0, disputed: false } });
  const chain = { select: vi.fn(), limit: vi.fn(), maxTimeMS: vi.fn(), lean: mocks.lean };
  chain.select.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.maxTimeMS.mockReturnValue(chain);
  mocks.find.mockReturnValue(chain);
  mocks.lean.mockResolvedValue([]);
});
describe('invoice fulfillment evidence', () => {
  it('matches both stable keys and detects an alternate-key duplicate using real reader output', async () => {
    mocks.lean.mockResolvedValue(
      ['pi_one', 'in_one'].map((key, i) => ({
        _id: `tx${i}`,
        type: 'subscription',
        credits: 100,
        ownerId: 'user_one',
        ownerType: 'User',
        stripePaymentIntentId: key,
        createdAt: new Date(1700000020000),
      }))
    );
    const evidence = await invoiceEvidence(invoice());
    expect(mocks.find).toHaveBeenCalledWith({ $or: [{ stripePaymentIntentId: { $in: ['in_one', 'pi_one'] } }] });
    expect(evidence?.invoice).toMatchObject({ subscriptionRecordId: 'local_sub', expectsGrant: true });
    expect(classifyPayment(evidence!, new Date()).state).toBe('duplicate');
  });
  it('supports zero-dollar invoice-only organization cycles without inventing expected amounts', async () => {
    mocks.user.mockResolvedValue(null);
    mocks.org.mockResolvedValue({ id: 'org_one' });
    mocks.subscription.mockResolvedValue({ id: 'local_org_sub', ownerType: 'Organization', ownerId: 'org_one' });
    mocks.payments.mockResolvedValue({ data: [], has_more: false });
    const evidence = await invoiceEvidence(invoice({ amount_paid: 0 }));
    expect(evidence).toMatchObject({
      complete: true,
      amount: 0,
      expectedCredits: null,
      owner: { id: 'org_one', type: 'Organization' },
      invoice: { expectsGrant: true, paymentIntentIds: [] },
    });
    expect(classifyPayment(evidence!, new Date()).state).toBe('unmatched');
    expect(mocks.intent).not.toHaveBeenCalled();
  });
  it('leaves truncated and multi-payment evidence unknown', async () => {
    mocks.payments.mockResolvedValue({ data: [], has_more: true });
    expect((await invoiceEvidence(invoice()))?.complete).toBe(false);
    mocks.payments.mockResolvedValue({
      data: ['pi_one', 'pi_two'].map(id => ({ payment: { type: 'payment_intent', payment_intent: id } })),
      has_more: false,
    });
    expect((await invoiceEvidence(invoice()))?.complete).toBe(false);
  });
  it('does not infer an expected grant for initial or update invoices or mismatched subscription owners', async () => {
    expect((await invoiceEvidence(invoice({ billing_reason: 'subscription_create' })))?.invoice?.expectsGrant).toBe(
      false
    );
    expect((await invoiceEvidence(invoice({ billing_reason: 'subscription_update' })))?.invoice?.expectsGrant).toBe(
      false
    );
    mocks.subscription.mockResolvedValue({ id: 'local_sub', ownerType: 'User', ownerId: 'different' });
    expect((await invoiceEvidence(invoice()))?.invoice?.expectsGrant).toBe(false);
  });
  it('skips unrelated provider invoices and propagates provider failures to the unavailable boundary', async () => {
    expect(
      await invoiceEvidence(
        invoice({ parent: { subscription_details: { subscription: 'sub_one', metadata: { stage: 'foreign' } } } })
      )
    ).toBeNull();
    expect(mocks.subscription).not.toHaveBeenCalled();
    mocks.subscription.mockResolvedValue(null);
    mocks.user.mockResolvedValue(null);
    expect(await invoiceEvidence(invoice())).toBeNull();
    expect(mocks.payments).not.toHaveBeenCalled();
    mocks.user.mockResolvedValue({ id: 'user_one' });
    mocks.payments.mockRejectedValue(new Error('provider failed'));
    await expect(invoiceEvidence(invoice())).rejects.toThrow('provider failed');
  });
});
