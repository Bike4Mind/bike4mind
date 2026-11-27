import { beforeEach, describe, expect, it, vi } from 'vitest';

const models = vi.hoisted(() => ({ createIndexes: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ PendingCreditHoldModel: { createIndexes: models.createIndexes } }));
import migration from './20260921239997_ensure-pending-credit-hold-owner-index';

describe('pending credit hold owner index migration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('builds the pending credit hold indexes', async () => {
    await migration.up();
    expect(models.createIndexes).toHaveBeenCalledExactlyOnceWith();
  });

  it('propagates an index build failure so the migration remains retryable', async () => {
    models.createIndexes.mockRejectedValueOnce(new Error('index build failed'));
    await expect(migration.up()).rejects.toThrow('index build failed');
  });

  it('does not drop indexes on rollback', async () => {
    await migration.down();
    expect(models.createIndexes).not.toHaveBeenCalled();
  });
});
