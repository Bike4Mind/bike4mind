import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAdminSubscriptionStripeCache, getAdminSubscriptionStripe } from './getAdminSubscriptionStripe';

const ID = 'a'.repeat(24);
const OWNER = 'b'.repeat(24);

const mocks = vi.hoisted(() => ({
  subscription: vi.fn(),
  ledger: vi.fn(),
  configured: vi.fn(),
  retrieve: vi.fn(),
  list: vi.fn(),
  createPreview: vi.fn(),
}));

vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<object>()),
  CreditTransaction: {
    find: (query: unknown) => ({
      select: () => ({ maxTimeMS: () => ({ lean: () => mocks.ledger(query) }) }),
    }),
  },
}));
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({
  Subscription: { findById: () => ({ maxTimeMS: () => ({ lean: () => mocks.subscription() }) }) },
}));

// Only the three read methods exist: any other Stripe call (a write) throws and fails the test.
const readOnlyStripe = new Proxy(
  {},
  {
    get: (_, resource: string) =>
      new Proxy(
        {},
        {
          get: (_target, method: string) => {
            const allowed: Record<string, unknown> = {
              'subscriptions.retrieve': mocks.retrieve,
              'invoices.list': mocks.list,
              'invoices.createPreview': mocks.createPreview,
            };
            const fn = allowed[`${resource}.${method}`];
            if (!fn) throw new Error(`Stripe write or unexpected call: ${resource}.${method}`);
            return fn;
          },
        }
      ),
  }
);
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  isStripeConfigured: mocks.configured,
  getStripe: () => readOnlyStripe,
}));

const stripeDoc = { ownerType: 'User', ownerId: OWNER, subscriptionId: 'sub_1', source: 'stripe' };
const invoice = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  number: `N-${id}`,
  created: 1_760_000_000,
  amount_due: 1000,
  amount_paid: 1000,
  currency: 'usd',
  status: 'paid',
  status_transitions: { paid_at: 1_760_000_100 },
  attempt_count: 1,
  hosted_invoice_url: `https://stripe.test/${id}`,
  payments: { data: [{ payment: { type: 'payment_intent', payment_intent: `pi_${id}` } }] },
  ...extra,
});
const stripeSub = {
  id: 'sub_1',
  status: 'active',
  customer: { invoice_settings: { default_payment_method: null } },
  default_payment_method: { type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } },
  items: { data: [{ current_period_end: 1_770_000_000 }] },
};

const pages = (invoices: unknown[]) => ({
  async *[Symbol.asyncIterator]() {
    yield* invoices;
  },
});

describe('getAdminSubscriptionStripe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAdminSubscriptionStripeCache();
    mocks.subscription.mockResolvedValue(stripeDoc);
    mocks.configured.mockReturnValue(true);
    mocks.retrieve.mockResolvedValue(stripeSub);
    mocks.list.mockReturnValue(pages([invoice('in_1'), invoice('in_2')]));
    mocks.createPreview.mockResolvedValue({ amount_due: 2500, currency: 'usd' });
    mocks.ledger.mockResolvedValue([]);
  });
  afterEach(() => vi.useRealTimers());

  it('reads card, invoices, upcoming and lifetime paid with only read calls', async () => {
    const result = await getAdminSubscriptionStripe(ID);
    expect(result).toMatchObject({
      kind: 'stripe',
      paymentMethod: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 },
      upcoming: { amount: 2500, currency: 'usd' },
      lifetimePaid: [{ amount: 2000, currency: 'usd' }],
      invoicesTruncated: false,
    });
    expect(mocks.createPreview).toHaveBeenCalledWith({ subscription: 'sub_1' });
  });

  it('falls back to the customer default payment method', async () => {
    mocks.retrieve.mockResolvedValue({
      ...stripeSub,
      default_payment_method: null,
      customer: {
        invoice_settings: { default_payment_method: { type: 'card', card: { brand: 'amex', last4: '0005' } } },
      },
    });
    expect(await getAdminSubscriptionStripe(ID)).toMatchObject({ paymentMethod: { brand: 'amex', last4: '0005' } });
  });

  it('joins credits by payment intent or invoice id, scoped to the owner, and leaves a gap as null', async () => {
    mocks.list.mockReturnValue(pages([invoice('in_1'), invoice('in_2', { payments: { data: [] } }), invoice('in_3')]));
    mocks.ledger.mockResolvedValue([
      { credits: 500, stripePaymentIntentId: 'pi_in_1' },
      { credits: 700, stripePaymentIntentId: 'in_2' },
    ]);
    const result = await getAdminSubscriptionStripe(ID);
    expect(result).toMatchObject({
      invoices: [{ creditsGranted: 500 }, { creditsGranted: 700 }, { creditsGranted: null }],
    });
    expect(mocks.ledger).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: OWNER, ownerType: 'User', type: 'subscription' })
    );
  });

  it('counts only paid invoices toward lifetime paid, per currency', async () => {
    mocks.list.mockReturnValue(
      pages([
        invoice('in_1'),
        invoice('in_2', { status: 'open', amount_paid: 0 }),
        invoice('in_3', { currency: 'eur', amount_paid: 400 }),
      ])
    );
    expect(await getAdminSubscriptionStripe(ID)).toMatchObject({
      lifetimePaid: [
        { amount: 1000, currency: 'usd' },
        { amount: 400, currency: 'eur' },
      ],
    });
  });

  it('flags truncation at the invoice cap', async () => {
    mocks.list.mockReturnValue(pages(Array.from({ length: 301 }, (_, index) => invoice(`in_${index}`))));
    const result = await getAdminSubscriptionStripe(ID);
    expect(result).toMatchObject({ invoicesTruncated: true });
    expect((result as { invoices: unknown[] }).invoices).toHaveLength(300);
  });

  it('keeps invoices when the upcoming preview fails, and skips it for a canceling subscription', async () => {
    mocks.createPreview.mockRejectedValue(new Error('preview down'));
    expect(await getAdminSubscriptionStripe(ID, { fresh: true })).toMatchObject({ upcoming: null, invoices: [{}, {}] });
    mocks.createPreview.mockClear();
    mocks.retrieve.mockResolvedValue({ ...stripeSub, cancel_at_period_end: true });
    expect(await getAdminSubscriptionStripe(ID, { fresh: true })).toMatchObject({ upcoming: null });
    expect(mocks.createPreview).not.toHaveBeenCalled();
  });

  it('answers a comp without touching Stripe', async () => {
    mocks.subscription.mockResolvedValue({ ...stripeDoc, source: 'admin_grant', subscriptionId: 'admin_grant_1' });
    expect(await getAdminSubscriptionStripe(ID)).toEqual({ stripeConfigured: true, kind: 'comp' });
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });

  it('reports an unconfigured deployment', async () => {
    mocks.configured.mockReturnValue(false);
    expect(await getAdminSubscriptionStripe(ID)).toEqual({ stripeConfigured: false });
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });

  it('reports a subscription Stripe does not know, and propagates other Stripe errors', async () => {
    mocks.retrieve.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'resource_missing' }));
    expect(await getAdminSubscriptionStripe(ID)).toEqual({ stripeConfigured: true, kind: 'missing' });
    mocks.retrieve.mockRejectedValueOnce(new Error('rate limited'));
    await expect(getAdminSubscriptionStripe(ID)).rejects.toThrow('rate limited');
  });

  it('returns null for an unknown or malformed id', async () => {
    mocks.subscription.mockResolvedValue(null);
    expect(await getAdminSubscriptionStripe(ID)).toBeNull();
    expect(await getAdminSubscriptionStripe('nope')).toBeNull();
  });

  it('caches a success for 60 s, bypasses on fresh, and never caches an error', async () => {
    vi.useFakeTimers();
    await getAdminSubscriptionStripe(ID);
    await getAdminSubscriptionStripe(ID);
    expect(mocks.retrieve).toHaveBeenCalledTimes(1);
    await getAdminSubscriptionStripe(ID, { fresh: true });
    expect(mocks.retrieve).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_001);
    await getAdminSubscriptionStripe(ID);
    expect(mocks.retrieve).toHaveBeenCalledTimes(3);

    clearAdminSubscriptionStripeCache();
    mocks.retrieve.mockRejectedValueOnce(new Error('boom'));
    await expect(getAdminSubscriptionStripe(ID)).rejects.toThrow('boom');
    await getAdminSubscriptionStripe(ID);
    expect(mocks.retrieve).toHaveBeenCalledTimes(5);
  });
});
