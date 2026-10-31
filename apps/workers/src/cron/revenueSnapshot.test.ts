import type { Context } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockConnectDB = vi.hoisted(() => vi.fn());
const mockUpsertSnapshot = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({
  connectDB: mockConnectDB,
  revenueSnapshotRepository: { upsertSnapshot: mockUpsertSnapshot },
}));

const mockComputeRevenueSnapshot = vi.hoisted(() => vi.fn());
vi.mock('@server/admin/revenue/revenueSnapshot', () => ({ computeRevenueSnapshot: mockComputeRevenueSnapshot }));

const mockIsStripeConfigured = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({ isStripeConfigured: mockIsStripeConfigured }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://test/%STAGE%' } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@bike4mind/observability', () => {
  class MockLogger {
    withMetadata() {
      return this;
    }
    log() {}
  }
  return { Logger: MockLogger };
});

import { handler, runRevenueSnapshot, snapshotDayFor } from './revenueSnapshot';

const zero = { amount: 0, unpriced: 0, otherCurrency: 0 };
const snapshotOf = (day: string) => ({
  snapshotDate: day,
  currency: 'usd',
  mrr: { amount: 1900, unpriced: 0, otherCurrency: 0 },
  payingCount: 1,
  newMrr: zero,
  churnedMrr: zero,
});

const context = { awsRequestId: 'req-1', functionName: 'revenueSnapshot' } as Context;

beforeEach(() => {
  vi.clearAllMocks();
  mockIsStripeConfigured.mockReturnValue(true);
  mockComputeRevenueSnapshot.mockImplementation(async (day: string) => snapshotOf(day));
});

describe('snapshotDayFor', () => {
  it('records the UTC day that just ended', () => {
    expect(snapshotDayFor(new Date('2026-10-30T00:20:00Z'))).toBe('2026-10-29');
    expect(snapshotDayFor(new Date('2026-03-01T00:20:00Z'))).toBe('2026-02-28');
    expect(snapshotDayFor(new Date('2027-01-01T00:20:00Z'))).toBe('2026-12-31');
  });
});

describe('runRevenueSnapshot', () => {
  it('computes the ended day at run time and upserts it under that day', async () => {
    const now = new Date('2026-10-30T00:20:00Z');
    await runRevenueSnapshot(undefined, now);
    expect(mockComputeRevenueSnapshot).toHaveBeenCalledWith('2026-10-29', now);
    expect(mockUpsertSnapshot).toHaveBeenCalledWith(snapshotOf('2026-10-29'));
  });

  it('keys a rerun on the same day to the same row', async () => {
    await runRevenueSnapshot(undefined, new Date('2026-10-30T00:20:00Z'));
    await runRevenueSnapshot(undefined, new Date('2026-10-30T09:00:00Z'));
    const days = mockUpsertSnapshot.mock.calls.map(([snapshot]) => snapshot.snapshotDate);
    expect(days).toEqual(['2026-10-29', '2026-10-29']);
  });

  it('lets a failed write throw, so the invoke retries and then reaches the dead-letter queue', async () => {
    mockUpsertSnapshot.mockRejectedValueOnce(new Error('write failed'));
    await expect(runRevenueSnapshot(undefined, new Date('2026-10-30T00:20:00Z'))).rejects.toThrow('write failed');
  });
});

describe('handler', () => {
  it('connects to the stage database and writes the snapshot', async () => {
    const result = await handler({}, context);
    expect(mockConnectDB).toHaveBeenCalledWith('mongodb://test/test', expect.anything());
    expect(mockUpsertSnapshot).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.body)).toEqual({ snapshotDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });

  it('skips a deployment without Stripe', async () => {
    mockIsStripeConfigured.mockReturnValue(false);
    const result = await handler({}, context);
    expect(JSON.parse(result.body)).toEqual({ skipped: true });
    expect(mockConnectDB).not.toHaveBeenCalled();
    expect(mockUpsertSnapshot).not.toHaveBeenCalled();
  });
});
