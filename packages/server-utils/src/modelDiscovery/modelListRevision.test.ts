import { beforeEach, describe, expect, it, vi } from 'vitest';

const { calls, createOrUpdate, findOneAndUpdate } = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    createOrUpdate: vi.fn(async (_doc: unknown) => {
      calls.push('cache');
    }),
    findOneAndUpdate: vi.fn(async () => {
      calls.push('setting');
    }),
  };
});

vi.mock('@bike4mind/database', () => ({
  cacheRepository: { createOrUpdate },
  AdminSettings: { findOneAndUpdate },
}));

const { MODEL_LIST_REVISION_SETTING, bumpModelListRevision } = await import('./modelListRevision');

describe('bumpModelListRevision', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
  });

  it('writes one new revision to the cache row and the setting row', async () => {
    const revision = await bumpModelListRevision();

    expect(createOrUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'model-list-revision', result: { revision } })
    );
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { settingName: MODEL_LIST_REVISION_SETTING },
      { $set: { settingValue: revision } },
      { upsert: true }
    );
  });

  it('writes the cache row before the setting row that wakes open tabs', async () => {
    await bumpModelListRevision();
    expect(calls).toEqual(['cache', 'setting']);
  });

  it('never reuses a revision', async () => {
    expect(await bumpModelListRevision()).not.toBe(await bumpModelListRevision());
  });

  it('never lets the revision row expire, since the setting row it mirrors does not', async () => {
    await bumpModelListRevision();

    const { expiresAt } = createOrUpdate.mock.calls[0][0] as { expiresAt: Date };
    expect(expiresAt.getUTCFullYear()).toBe(9999);
  });
});
