import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findOneAndUpdate, findOne } = vi.hoisted(() => ({
  findOneAndUpdate: vi.fn(async () => null),
  findOne: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  AdminSettings: { findOneAndUpdate, findOne },
}));

const { MODEL_ACCESS_REVISION_SETTING, bumpModelAccessRevision, readModelAccessRevision } =
  await import('./modelAccessRevision');

describe('bumpModelAccessRevision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes a new revision to the setting row only', async () => {
    const revision = await bumpModelAccessRevision();

    expect(MODEL_ACCESS_REVISION_SETTING).toBe('modelAccessRevision');
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { settingName: 'modelAccessRevision' },
      { $set: { settingValue: revision } },
      { upsert: true }
    );
  });

  it('never reuses a revision', async () => {
    expect(await bumpModelAccessRevision()).not.toBe(await bumpModelAccessRevision());
  });
});

describe('readModelAccessRevision', () => {
  it('reads the stored stamp, and no row or an empty value as unset', async () => {
    findOne.mockReturnValueOnce({ lean: async () => ({ settingValue: 'r1' }) });
    await expect(readModelAccessRevision()).resolves.toBe('r1');

    findOne.mockReturnValueOnce({ lean: async () => null });
    await expect(readModelAccessRevision()).resolves.toBeNull();

    findOne.mockReturnValueOnce({ lean: async () => ({ settingValue: '' }) });
    await expect(readModelAccessRevision()).resolves.toBeNull();
  });
});
