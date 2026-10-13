import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindByPaymentIntentId = vi.fn();
const mockFindUserById = vi.fn();
const mockConnectDB = vi.fn();
vi.mock('@bike4mind/database', () => ({
  connectDB: (...args: unknown[]) => mockConnectDB(...args),
  creditTransactionRepository: {
    findByPaymentIntentId: (...args: unknown[]) => mockFindByPaymentIntentId(...args),
  },
  userRepository: {
    findById: (...args: unknown[]) => mockFindUserById(...args),
  },
}));

const mockList = vi.fn();
const mockIsStripeConfigured = vi.fn();
vi.mock('@server/integrations/stripe/stripe', () => ({
  isStripeConfigured: () => mockIsStripeConfigured(),
  stripe: { paymentIntents: { list: (...args: unknown[]) => mockList(...args) } },
}));

const mockPostMessageToSlack = vi.fn();
vi.mock('@server/integrations/slack/slack', () => ({
  postMessageToSlack: (...args: unknown[]) => mockPostMessageToSlack(...args),
}));

const mockEmitMetric = vi.fn();
vi.mock('@server/utils/cloudwatch', () => ({
  emitMetric: (...args: unknown[]) => mockEmitMetric(...args),
}));

vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://test/%STAGE%' } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));

const mockLoggerError = vi.fn();
const mockLoggerWarn = vi.fn();
vi.mock('@bike4mind/observability', () => {
  class MockLogger {
    withMetadata() {
      return this;
    }
    log() {}
    info() {}
    warn(...args: unknown[]) {
      mockLoggerWarn(...args);
    }
    error(...args: unknown[]) {
      mockLoggerError(...args);
    }
  }
  return { Logger: MockLogger };
});

import {
  GRACE_MS,
  handler,
  LOOKBACK_MS,
  MAX_PAGES,
  runCreditPurchaseReconciliation,
} from './creditPurchaseReconciliation';

const NOW = new Date('2026-10-11T07:00:00Z');

const TX_CREATED_AT = new Date('2026-10-11T06:00:05Z');
const purchaseRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'tx_1',
  ownerId: 'user_1',
  ownerType: 'User',
  createdAt: TX_CREATED_AT,
  ...overrides,
});

const intent = (id: string, overrides: Record<string, unknown> = {}, metadata: Record<string, string> = {}) => ({
  id,
  status: 'succeeded',
  amount: 1000,
  currency: 'usd',
  created: Math.floor(NOW.getTime() / 1000) - 3600,
  metadata: { environment: 'test', credits: '10000', userId: 'user_1', ...metadata },
  ...overrides,
});

describe('creditPurchaseReconciliation cron', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsStripeConfigured.mockReturnValue(true);
    mockFindByPaymentIntentId.mockResolvedValue({
      id: 'tx_1',
      ownerId: 'user_1',
      ownerType: 'User',
      createdAt: new Date(NOW.getTime() - 3600_000),
    });
    mockFindUserById.mockResolvedValue({ lastCreditsPurchasedAt: new Date(NOW.getTime() - 3600_000 + 50) });
  });

  it('lists only the lookback window, minus the webhook grace period', async () => {
    mockList.mockResolvedValue({ data: [], has_more: false });

    await runCreditPurchaseReconciliation(undefined, NOW);

    expect(mockList).toHaveBeenCalledWith({
      created: {
        gte: Math.floor((NOW.getTime() - LOOKBACK_MS) / 1000),
        lte: Math.floor((NOW.getTime() - GRACE_MS) / 1000),
      },
      limit: 100,
    });
  });

  it('alerts on a succeeded credit purchase with no purchase transaction', async () => {
    mockList.mockResolvedValue({ data: [intent('pi_granted'), intent('pi_missing')], has_more: false });
    mockFindByPaymentIntentId.mockImplementation(async (id: string) => (id === 'pi_granted' ? purchaseRow() : null));

    const result = await runCreditPurchaseReconciliation(undefined, NOW);

    expect(result.checked).toBe(2);
    expect(result.ungranted).toEqual([
      {
        paymentIntentId: 'pi_missing',
        reason: 'no_transaction',
        userId: 'user_1',
        amount: 1000,
        currency: 'usd',
        credits: 10000,
        createdAt: '2026-10-11T06:00:00.000Z',
      },
    ]);
    expect(mockPostMessageToSlack).toHaveBeenCalledTimes(1);
    const message = mockPostMessageToSlack.mock.calls[0][0] as string;
    expect(message).toContain('pi_missing');
    expect(message).toContain('$10.00 USD');
    expect(message).not.toContain('pi_granted');
    expect(message).not.toContain('Balance never credited');
    expect(mockEmitMetric).toHaveBeenCalledWith(
      'Lumina5/CreditPurchases',
      'UngrantedPurchases',
      1,
      { Stage: 'test' },
      'Count'
    );
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining('no grant'),
      expect.objectContaining({ paymentIntentId: 'pi_missing' })
    );
  });

  describe('purchase transaction exists', () => {
    beforeEach(() => {
      mockList.mockResolvedValue({ data: [intent('pi_1')], has_more: false });
      mockFindByPaymentIntentId.mockResolvedValue(purchaseRow());
    });

    it('treats the purchase as granted when the balance increment stamped the owner after the row', async () => {
      mockFindUserById.mockResolvedValue({ lastCreditsPurchasedAt: new Date(TX_CREATED_AT.getTime() + 20) });

      const result = await runCreditPurchaseReconciliation(undefined, NOW);

      expect(mockFindUserById).toHaveBeenCalledWith('user_1');
      expect(result.ungranted).toEqual([]);
      expect(mockPostMessageToSlack).not.toHaveBeenCalled();
    });

    it('flags a row whose balance increment never ran (owner stamp older than the row)', async () => {
      mockFindUserById.mockResolvedValue({ lastCreditsPurchasedAt: new Date('2026-09-01T00:00:00Z') });

      const result = await runCreditPurchaseReconciliation(undefined, NOW);

      expect(result.ungranted).toEqual([
        expect.objectContaining({ paymentIntentId: 'pi_1', reason: 'balance_not_applied' }),
      ]);
      const message = mockPostMessageToSlack.mock.calls[0][0] as string;
      expect(message).toContain('pi_1 (transaction recorded but balance never credited)');
      expect(message).toContain('admin credit adjustment');
      expect(message).toContain('clears this alert on the next run');
      expect(message).toContain('clears every balance-never-credited line');
      expect(message).toContain('not just the listed ones');
      expect(message).not.toContain('No purchase transaction:');
      expect(mockEmitMetric).toHaveBeenCalledWith(
        'Lumina5/CreditPurchases',
        'UngrantedPurchases',
        1,
        { Stage: 'test' },
        'Count'
      );
    });

    it('tolerates clock skew between the row and the owner stamp', async () => {
      mockFindUserById.mockResolvedValue({ lastCreditsPurchasedAt: new Date(TX_CREATED_AT.getTime() - 30_000) });

      const result = await runCreditPurchaseReconciliation(undefined, NOW);

      expect(result.ungranted).toEqual([]);
    });

    it('flags a row when the owner was never stamped by any purchase', async () => {
      mockFindUserById.mockResolvedValue({ lastCreditsPurchasedAt: null });

      const result = await runCreditPurchaseReconciliation(undefined, NOW);

      expect(result.ungranted.map(p => p.reason)).toEqual(['balance_not_applied']);
    });

    it('flags a row whose owner no longer exists', async () => {
      mockFindUserById.mockResolvedValue(null);

      const result = await runCreditPurchaseReconciliation(undefined, NOW);

      expect(result.ungranted.map(p => p.reason)).toEqual(['owner_missing']);
      expect(mockPostMessageToSlack.mock.calls[0][0]).toContain('Owner missing');
    });

    it('names the ledger owner rather than the intent metadata user, so credits reach the right account', async () => {
      mockList.mockResolvedValue({ data: [intent('pi_1', {}, { userId: 'user_metadata' })], has_more: false });
      mockFindByPaymentIntentId.mockResolvedValue(purchaseRow({ ownerId: 'user_owner' }));
      mockFindUserById.mockResolvedValue({ lastCreditsPurchasedAt: new Date('2026-09-01T00:00:00Z') });

      const result = await runCreditPurchaseReconciliation(undefined, NOW);

      expect(result.ungranted).toEqual([
        expect.objectContaining({ paymentIntentId: 'pi_1', reason: 'balance_not_applied', userId: 'user_owner' }),
      ]);
      const message = mockPostMessageToSlack.mock.calls[0][0] as string;
      expect(message).toContain('user user_owner');
      expect(message).not.toContain('user_metadata');
    });

    it('treats a row repaired by the audit script (balanceBackfilledAt) as applied', async () => {
      mockFindByPaymentIntentId.mockResolvedValue(purchaseRow({ metadata: { balanceBackfilledAt: new Date() } }));
      mockFindUserById.mockResolvedValue({ lastCreditsPurchasedAt: null });

      const result = await runCreditPurchaseReconciliation(undefined, NOW);

      expect(result.ungranted).toEqual([]);
    });

    it('fails loudly when the owner lookup rejects, without emitting a partial result', async () => {
      mockFindUserById.mockRejectedValueOnce(new Error('db'));

      await expect(runCreditPurchaseReconciliation(undefined, NOW)).rejects.toThrow('db');
      expect(mockEmitMetric).not.toHaveBeenCalled();
    });

    it('skips the balance check for non-user owners', async () => {
      mockFindByPaymentIntentId.mockResolvedValue(purchaseRow({ ownerType: 'Organization' }));

      const result = await runCreditPurchaseReconciliation(undefined, NOW);

      expect(mockFindUserById).not.toHaveBeenCalled();
      expect(result.ungranted).toEqual([]);
    });

    it('reports both kinds of failure in one alert, labelled by reason', async () => {
      mockList.mockResolvedValue({ data: [intent('pi_no_row'), intent('pi_no_balance')], has_more: false });
      mockFindByPaymentIntentId.mockImplementation(async (id: string) => (id === 'pi_no_row' ? null : purchaseRow()));
      mockFindUserById.mockResolvedValue({ lastCreditsPurchasedAt: null });

      const result = await runCreditPurchaseReconciliation(undefined, NOW);

      expect(result.ungranted.map(p => [p.paymentIntentId, p.reason])).toEqual([
        ['pi_no_row', 'no_transaction'],
        ['pi_no_balance', 'balance_not_applied'],
      ]);
      const message = mockPostMessageToSlack.mock.calls[0][0] as string;
      expect(message).toContain('pi_no_row (no purchase transaction)');
      expect(message).toContain('pi_no_balance (transaction recorded but balance never credited)');
      expect(message).toContain('No purchase transaction: verify in Stripe');
      expect(message).toContain('Balance never credited: check the user balance');
    });
  });

  it('ignores intents that are not succeeded credit purchases for this stage', async () => {
    mockList.mockResolvedValue({
      data: [
        intent('pi_pending', { status: 'requires_payment_method' }),
        intent('pi_other_stage', {}, { environment: 'production' }),
        intent('pi_subscription', { metadata: { environment: 'test' } }),
      ],
      has_more: false,
    });

    const result = await runCreditPurchaseReconciliation(undefined, NOW);

    expect(result.checked).toBe(0);
    expect(mockFindByPaymentIntentId).not.toHaveBeenCalled();
    expect(mockPostMessageToSlack).not.toHaveBeenCalled();
    expect(mockEmitMetric).toHaveBeenCalledWith(
      'Lumina5/CreditPurchases',
      'UngrantedPurchases',
      0,
      { Stage: 'test' },
      'Count'
    );
  });

  it('pages with starting_after until Stripe reports no more', async () => {
    mockList
      .mockResolvedValueOnce({ data: [intent('pi_1'), intent('pi_2')], has_more: true })
      .mockResolvedValueOnce({ data: [intent('pi_3')], has_more: false });

    const result = await runCreditPurchaseReconciliation(undefined, NOW);

    expect(mockList).toHaveBeenCalledTimes(2);
    expect(mockList.mock.calls[1][0]).toEqual(expect.objectContaining({ starting_after: 'pi_2' }));
    expect(result).toEqual(expect.objectContaining({ checked: 3, truncated: false }));
  });

  it('stops at the page cap and says the scan was truncated', async () => {
    let n = 0;
    mockList.mockImplementation(async () => ({ data: [intent(`pi_${n++}`)], has_more: true }));
    mockFindByPaymentIntentId.mockResolvedValue(null);

    const result = await runCreditPurchaseReconciliation(undefined, NOW);

    expect(mockList).toHaveBeenCalledTimes(MAX_PAGES);
    expect(result.truncated).toBe(true);
    expect(mockLoggerWarn).toHaveBeenCalled();
    expect(mockPostMessageToSlack.mock.calls[0][0]).toContain('truncated');
  });

  it('skips without touching Stripe or the database when Stripe is not configured', async () => {
    mockIsStripeConfigured.mockReturnValue(false);

    const response = await handler(undefined, {} as never);

    expect(JSON.parse(response.body)).toEqual({ skipped: true });
    expect(mockList).not.toHaveBeenCalled();
    expect(mockConnectDB).not.toHaveBeenCalled();
  });

  it('connects to this stage database and reports the counts when configured', async () => {
    mockList.mockResolvedValue({ data: [intent('pi_granted'), intent('pi_missing')], has_more: false });
    mockFindByPaymentIntentId.mockImplementation(async (id: string) => (id === 'pi_granted' ? purchaseRow() : null));

    const response = await handler(undefined, {} as never);

    expect(mockConnectDB).toHaveBeenCalledWith('mongodb://test/test', expect.anything());
    expect(JSON.parse(response.body)).toEqual({ checked: 2, ungranted: 1, truncated: false });
  });

  it('flags an intent with no customer, which the webhook skips without granting', async () => {
    mockList.mockResolvedValue({ data: [intent('pi_no_customer', { customer: null })], has_more: false });
    mockFindByPaymentIntentId.mockResolvedValue(null);

    const result = await runCreditPurchaseReconciliation(undefined, NOW);

    expect(result.ungranted.map(purchase => purchase.paymentIntentId)).toEqual(['pi_no_customer']);
  });

  it('caps the alert at 20 lines and says how many more are in the logs', async () => {
    mockList.mockResolvedValue({
      data: Array.from({ length: 23 }, (_, index) => intent(`pi_${index}`)),
      has_more: false,
    });
    mockFindByPaymentIntentId.mockResolvedValue(null);

    const result = await runCreditPurchaseReconciliation(undefined, NOW);

    const message = mockPostMessageToSlack.mock.calls[0][0] as string;
    expect(result.ungranted).toHaveLength(23);
    expect(message.match(/- pi_/g)).toHaveLength(20);
    expect(message).toContain('...and 3 more');
    expect(mockLoggerError).toHaveBeenCalledTimes(23);
  });
});
