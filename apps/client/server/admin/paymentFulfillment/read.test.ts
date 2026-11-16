import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentFulfillmentQuery } from '@client/app/utils/paymentFulfillment';

const mocks = vi.hoisted(() => ({
  configured: vi.fn(),
  payments: vi.fn(),
  refunds: vi.fn(),
  disputes: vi.fn(),
  user: vi.fn(),
  org: vi.fn(),
  find: vi.fn(),
  lean: vi.fn(),
  invoices: vi.fn(),
  invoiceEvidence: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  CreditTransaction: { find: mocks.find },
  userRepository: { findByStripeCustomerId: mocks.user },
  organizationRepository: { findByStripeCustomerId: mocks.org },
}));
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  isStripeConfigured: mocks.configured,
  stripe: {
    paymentIntents: { list: mocks.payments },
    refunds: { list: mocks.refunds },
    disputes: { list: mocks.disputes },
    invoices: { list: mocks.invoices },
  },
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { STAGE: 'test-stage' } }));
vi.mock('./invoices', () => ({ invoiceEvidence: mocks.invoiceEvidence }));
import { readPaymentFulfillment } from './read';
const logger = { error: vi.fn() };
const read = (query: Parameters<typeof readPaymentFulfillment>[0]) => readPaymentFulfillment(query, logger);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.configured.mockReturnValue(true);
  mocks.user.mockResolvedValue({ id: 'u1' });
  mocks.org.mockResolvedValue(null);
  mocks.refunds.mockResolvedValue({ data: [], has_more: false });
  mocks.disputes.mockResolvedValue({ data: [], has_more: false });
  const chain = { select: vi.fn(), limit: vi.fn(), maxTimeMS: vi.fn(), lean: mocks.lean };
  chain.select.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.maxTimeMS.mockReturnValue(chain);
  mocks.find.mockReturnValue(chain);
  mocks.lean.mockResolvedValue([]);
  mocks.payments.mockResolvedValue({
    has_more: true,
    data: [
      {
        id: 'pi_abc',
        created: 1700000000,
        amount: 1000,
        currency: 'usd',
        livemode: false,
        status: 'succeeded',
        customer: 'cus_1',
        metadata: { credits: '100', userId: 'u1', environment: 'test-stage' },
        latest_charge: {
          id: 'ch_1',
          paid: true,
          amount: 1000,
          amount_refunded: 250,
          created: 1700000000,
          disputed: false,
        },
      },
    ],
  });
});

describe('read-only provider reconciliation', () => {
  it('returns unavailable without a provider and does not query records', async () => {
    mocks.configured.mockReturnValue(false);
    expect(await read(PaymentFulfillmentQuery.parse({}))).toMatchObject({
      availability: 'unavailable',
      items: [],
    });
    expect(mocks.payments).not.toHaveBeenCalled();
    expect(mocks.find).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
  it('never converts provider or ledger lookup failures into an all-clear', async () => {
    mocks.refunds.mockRejectedValue(new Error('provider unavailable'));
    expect((await read(PaymentFulfillmentQuery.parse({}))).availability).toBe('unavailable');
    expect(logger.error).toHaveBeenLastCalledWith(
      'Payment fulfillment evidence lookup failed',
      expect.objectContaining({ message: 'provider unavailable' })
    );
    mocks.refunds.mockResolvedValue({ data: [], has_more: false });
    mocks.lean.mockRejectedValue(new Error('database unavailable'));
    expect((await read(PaymentFulfillmentQuery.parse({}))).availability).toBe('unavailable');
    expect(logger.error).toHaveBeenLastCalledWith(
      'Payment fulfillment evidence lookup failed',
      expect.objectContaining({ message: 'database unavailable' })
    );
  });
  it('keeps pagination when a server-side category filter removes this entire page', async () => {
    const result = await read(PaymentFulfillmentQuery.parse({ state: 'consistent', cursor: 'pi_prev', limit: 5 }));
    expect(result).toMatchObject({ availability: 'available', items: [], scanned: 1, nextCursor: 'pi_abc' });
    expect(mocks.payments).toHaveBeenCalledWith(expect.objectContaining({ starting_after: 'pi_prev', limit: 5 }));
  });
  it('treats truncated refund evidence and ambiguous ownership as unknown', async () => {
    mocks.refunds.mockResolvedValue({ data: [], has_more: true });
    expect((await read(PaymentFulfillmentQuery.parse({}))).items[0].state).toBe('unknown');
    mocks.refunds.mockResolvedValue({ data: [], has_more: false });
    mocks.org.mockResolvedValue({ id: 'o1' });
    expect((await read(PaymentFulfillmentQuery.parse({}))).items[0].state).toBe('unknown');
  });
  it('retains stage-owned credit packs without a linked customer or ledger row', async () => {
    mocks.user.mockResolvedValue(null);
    const result = await read(PaymentFulfillmentQuery.parse({}));
    expect(result).toMatchObject({
      availability: 'available',
      scanned: 1,
      items: [{ id: 'pi_abc', state: 'unknown', owner: null, product: 'credit_pack', expectedCredits: 100 }],
    });
  });
  it('excludes foreign-stage payments and unowned payments without local pack evidence', async () => {
    const payments = await mocks.payments();
    payments.data[0].metadata.environment = 'other-stage';
    mocks.payments.mockResolvedValue(payments);
    expect((await read(PaymentFulfillmentQuery.parse({}))).items).toEqual([]);
    expect(mocks.user).not.toHaveBeenCalled();
    delete payments.data[0].metadata.environment;
    delete payments.data[0].metadata.credits;
    mocks.user.mockResolvedValue(null);
    expect((await read(PaymentFulfillmentQuery.parse({}))).items).toEqual([]);
  });
  it('does not request refunds for a charge with no refunded amount', async () => {
    const payments = await mocks.payments();
    payments.data[0].latest_charge.amount_refunded = 0;
    mocks.payments.mockResolvedValue(payments);
    expect((await read(PaymentFulfillmentQuery.parse({}))).availability).toBe('available');
    expect(mocks.refunds).not.toHaveBeenCalled();
  });
  it('validates bounded periods, limits and stable provider cursors', () => {
    for (const query of [
      { days: 91 },
      { limit: 26 },
      { cursor: 'not-a-provider-id' },
      { source: 'invoices', cursor: 'pi_wrong' },
    ]) {
      expect(PaymentFulfillmentQuery.safeParse(query).success).toBe(false);
    }
  });
  it('paginates invoice reads independently and preserves unavailable on lookup failure', async () => {
    mocks.invoices.mockResolvedValue({ data: [{ id: 'in_next' }], has_more: true });
    mocks.invoiceEvidence.mockResolvedValue(null);
    const query = PaymentFulfillmentQuery.parse({ source: 'invoices', cursor: 'in_previous', limit: 5 });
    expect(await read(query)).toMatchObject({
      availability: 'available',
      nextCursor: 'in_next',
      scanned: 1,
      items: [],
    });
    expect(mocks.invoices).toHaveBeenCalledWith(expect.objectContaining({ starting_after: 'in_previous', limit: 5 }));
    mocks.invoiceEvidence.mockRejectedValue(new Error('invoice provider unavailable'));
    expect(await read(query)).toMatchObject({ availability: 'unavailable', items: [], nextCursor: null });
    expect(logger.error).toHaveBeenCalled();
  });
});
