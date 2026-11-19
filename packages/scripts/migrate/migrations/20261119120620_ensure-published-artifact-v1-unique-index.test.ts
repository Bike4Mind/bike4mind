import { beforeEach, describe, expect, it, vi } from 'vitest';

const models = vi.hoisted(() => ({ createIndexes: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ PublishedArtifact: { createIndexes: models.createIndexes } }));
import migration from './20261119120620_ensure-published-artifact-v1-unique-index';

describe('published artifact v1 unique index migration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('builds the published artifact indexes', async () => {
    await migration.up();
    expect(models.createIndexes).toHaveBeenCalledExactlyOnceWith();
  });

  it('propagates an index build failure so the migration remains retryable', async () => {
    models.createIndexes.mockRejectedValueOnce(new Error('index build failed'));
    await expect(migration.up()).rejects.toThrow('index build failed');
  });

  it('does not drop the index on rollback', async () => {
    await migration.down();
    expect(models.createIndexes).not.toHaveBeenCalled();
  });
});
