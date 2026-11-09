import { beforeEach, describe, expect, it, vi } from 'vitest';

const { calls, createOrUpdate, findOneAndUpdate } = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    createOrUpdate: vi.fn(async () => {
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

const { MODEL_LIST_REVISION_CACHE_KEY, MODEL_LIST_REVISION_SETTING, bumpModelListRevision, modelListRevisionOf } =
  await import('./modelListRevision');

describe('bumpModelListRevision', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
  });

  it('writes one new revision to the cache row and the setting row', async () => {
    const revision = await bumpModelListRevision();

    expect(createOrUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ key: MODEL_LIST_REVISION_CACHE_KEY, result: { revision } })
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

  it('keeps the revision key outside the per-caller model-list:* namespace', () => {
    expect(MODEL_LIST_REVISION_CACHE_KEY.startsWith('model-list:')).toBe(false);
  });
});

describe('modelListRevisionOf', () => {
  it('reads the stamp off a cache row', () => {
    expect(modelListRevisionOf({ result: { revision: 'r1' } })).toBe('r1');
  });

  it('reads a missing or malformed row as unset', () => {
    expect(modelListRevisionOf(null)).toBeNull();
    expect(modelListRevisionOf({ result: {} })).toBeNull();
    expect(modelListRevisionOf({ result: { revision: 7 } })).toBeNull();
    expect(modelListRevisionOf({ result: { revision: '' } })).toBeNull();
  });
});
