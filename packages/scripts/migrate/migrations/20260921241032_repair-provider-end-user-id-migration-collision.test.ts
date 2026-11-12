import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  backfill: vi.fn(),
  dropBackfillIndex: vi.fn(),
  creditIndexes: vi.fn(),
  billingIndexes: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  Migration: { exists: mocks.exists },
  CreditTransaction: { createIndexes: mocks.creditIndexes },
  BillingEventModel: { createIndexes: mocks.billingIndexes },
}));
vi.mock('./20260921241030_backfill-user-provider-end-user-id', () => ({
  default: { id: 20260921241030, up: mocks.backfill, down: mocks.dropBackfillIndex },
}));
import repair from './20260921241032_repair-provider-end-user-id-migration-collision';
import payments from './20260921241031_ensure-payments-report-indexes';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.backfill.mockResolvedValue(undefined);
});

describe('migration identity collision repair', () => {
  it.each([null, 'backfill user providerEndUserId'])(
    'leaves the provider backfill alone for ledger name %s',
    async name => {
      mocks.exists.mockImplementation(async (filter: { id: number; name: string }) =>
        name !== null && filter.name === name ? { _id: 'ledger-row' } : null
      );
      await repair.up();
      expect(mocks.exists).toHaveBeenCalledWith({ id: 20260921241030, name: 'ensure payments report indexes' });
      expect(mocks.backfill).not.toHaveBeenCalled();
    }
  );

  it('repairs a payments-only preview through the original idempotent backfill', async () => {
    mocks.exists.mockResolvedValue({ _id: 'ledger-row' });
    const ctx = { startedAt: new Date('2026-11-12T12:00:00Z') };
    await repair.up(ctx);
    expect(mocks.backfill).toHaveBeenCalledExactlyOnceWith(ctx);
  });

  it('propagates failures so an unfinished repair can be retried', async () => {
    mocks.exists.mockResolvedValue({ _id: 'ledger-row' });
    mocks.backfill.mockRejectedValueOnce(new Error('backfill unavailable'));
    await expect(repair.up()).rejects.toThrow('backfill unavailable');
    await expect(repair.up()).resolves.toBeUndefined();
    expect(mocks.backfill).toHaveBeenCalledTimes(2);
  });

  it('keeps payment index creation repeatable under its new identity', async () => {
    expect(payments.id).toBe(20260921241031);
    expect(repair.id).toBeGreaterThan(payments.id);
    await payments.up();
    await payments.up();
    expect(mocks.creditIndexes).toHaveBeenCalledTimes(2);
    expect(mocks.billingIndexes).toHaveBeenCalledTimes(2);
  });

  it('does not roll back the original provider index', async () => {
    await repair.down();
    expect(mocks.dropBackfillIndex).not.toHaveBeenCalled();
  });
});
