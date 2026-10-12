import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindByPaymentIntentId = vi.fn();
const mockConnectDB = vi.fn();
vi.mock('@bike4mind/database', () => ({
  connectDB: (...args: unknown[]) => mockConnectDB(...args),
  creditTransactionRepository: {
    findByPaymentIntentId: (...args: unknown[]) => mockFindByPaymentIntentId(...args),
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
    mockFindByPaymentIntentId.mockResolvedValue({ id: 'tx_1' });
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
    mockFindByPaymentIntentId.mockImplementation(async (id: string) => (id === 'pi_granted' ? { id: 'tx_1' } : null));

    const result = await runCreditPurchaseReconciliation(undefined, NOW);

    expect(result.checked).toBe(2);
    expect(result.ungranted).toEqual([
      {
        paymentIntentId: 'pi_missing',
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
    mockFindByPaymentIntentId.mockImplementation(async (id: string) => (id === 'pi_granted' ? { id: 'tx_1' } : null));

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
