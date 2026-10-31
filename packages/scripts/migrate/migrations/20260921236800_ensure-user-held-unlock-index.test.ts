import { beforeEach, describe, expect, it, vi } from 'vitest';

const models = vi.hoisted(() => ({ userIndexes: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ User: { createIndexes: models.userIndexes } }));
import migration from './20260921236800_ensure-user-held-unlock-index';

describe('held unlock index migration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('builds the user indexes, including the held unlock release index', async () => {
    await migration.up();
    expect(models.userIndexes).toHaveBeenCalledExactlyOnceWith();
  });

  it('propagates an index build failure so the migration remains retryable', async () => {
    models.userIndexes.mockRejectedValueOnce(new Error('index build failed'));
    await expect(migration.up()).rejects.toThrow('index build failed');
  });

  it('does not drop indexes on rollback', async () => {
    await migration.down();
    expect(models.userIndexes).not.toHaveBeenCalled();
  });
});
