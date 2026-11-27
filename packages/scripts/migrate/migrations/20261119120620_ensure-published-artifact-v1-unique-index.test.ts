import { beforeEach, describe, expect, it, vi } from 'vitest';

const models = vi.hoisted(() => ({ createIndex: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ PublishedArtifact: { collection: { createIndex: models.createIndex } } }));
import migration from './20261119120620_ensure-published-artifact-v1-unique-index';

describe('published artifact v1 unique index migration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('builds only the partial unique v1 index', async () => {
    await migration.up();
    expect(models.createIndex).toHaveBeenCalledExactlyOnceWith(
      { ownerId: 1, v1ArtifactId: 1 },
      {
        name: 'ownerId_1_v1ArtifactId_1',
        unique: true,
        partialFilterExpression: { v1ArtifactId: { $type: 'string' }, deletedAt: null },
      }
    );
  });

  it('propagates an index build failure so the migration remains retryable', async () => {
    models.createIndex.mockRejectedValueOnce(new Error('index build failed'));
    await expect(migration.up()).rejects.toThrow('index build failed');
  });

  it('does not drop the index on rollback', async () => {
    await migration.down();
    expect(models.createIndex).not.toHaveBeenCalled();
  });
});
