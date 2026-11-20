import { beforeEach, describe, expect, it, vi } from 'vitest';

const models = vi.hoisted(() => ({ questIndexes: vi.fn(), authEventIndexes: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  Quest: { createIndexes: models.questIndexes },
  AuthEventModel: { createIndexes: models.authEventIndexes },
}));
import migration from './20260921235966_ensure-quest-signup-activity-index';

describe('signup grant indexes migration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('builds activity and network signup indexes in the new migration', async () => {
    await migration.up();
    expect(models.questIndexes).toHaveBeenCalledExactlyOnceWith();
    expect(models.authEventIndexes).toHaveBeenCalledExactlyOnceWith();
  });

  it('propagates a network index failure so the migration remains retryable', async () => {
    models.authEventIndexes.mockRejectedValueOnce(new Error('index build failed'));
    await expect(migration.up()).rejects.toThrow('index build failed');
    await migration.up();
    expect(models.authEventIndexes).toHaveBeenCalledTimes(2);
  });

  it('does not drop indexes on rollback', async () => {
    await migration.down();
    expect(models.questIndexes).not.toHaveBeenCalled();
    expect(models.authEventIndexes).not.toHaveBeenCalled();
  });
});
