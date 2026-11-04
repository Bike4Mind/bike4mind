import { beforeEach, describe, expect, it, vi } from 'vitest';

const models = vi.hoisted(() => ({ fabFileIndexes: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ FabFile: { createIndexes: models.fabFileIndexes } }));
import migration from './20260921239600_ensure-fabfile-pending-upload-index';

describe('fabfile pending upload index migration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('builds the fabfile indexes', async () => {
    await migration.up();
    expect(models.fabFileIndexes).toHaveBeenCalledExactlyOnceWith();
  });

  it('propagates a build failure so the migration remains retryable', async () => {
    models.fabFileIndexes.mockRejectedValueOnce(new Error('index build failed'));
    await expect(migration.up()).rejects.toThrow('index build failed');
  });

  it('does not drop indexes on rollback', async () => {
    await migration.down();
    expect(models.fabFileIndexes).not.toHaveBeenCalled();
  });
});
