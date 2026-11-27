import { afterEach, describe, expect, it, vi } from 'vitest';
import { User } from '@bike4mind/database';
import migration from './20260921235956_ensure-user-riskscore-review-index';

const INDEX_NAME = 'user_riskScore_review';

describe('user riskScore review index migration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates the index with the key, name and options declared on the User schema', async () => {
    const createIndex = vi.spyOn(User.collection, 'createIndex').mockResolvedValue(INDEX_NAME);
    await migration.up();

    const declared = User.schema.indexes().find(([, options]) => options?.name === INDEX_NAME);
    expect(declared).toBeDefined();
    // mongoose adds `background`, which is not part of the index identity.
    const { background: _background, ...declaredOptions } = declared![1] ?? {};
    expect(createIndex).toHaveBeenCalledExactlyOnceWith(declared![0], declaredOptions);
  });

  it('propagates an index build failure so the migration remains retryable', async () => {
    vi.spyOn(User.collection, 'createIndex').mockRejectedValueOnce(new Error('index build failed'));
    await expect(migration.up()).rejects.toThrow('index build failed');
  });

  it('does not drop indexes on rollback', async () => {
    const dropIndex = vi.spyOn(User.collection, 'dropIndex');
    await migration.down();
    expect(dropIndex).not.toHaveBeenCalled();
  });
});
