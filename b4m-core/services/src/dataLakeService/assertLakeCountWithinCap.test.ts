import { describe, expect, it, vi } from 'vitest';
import { DATA_LAKE_LIMIT_REACHED_CODE, DATA_LAKE_MAX_LAKES_PER_USER_DEFAULT } from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/utils';
import { assertLakeCountWithinCap, resolveMaxLakesPerUser } from './assertLakeCountWithinCap';

const makeDb = (setting: string | number | null, existing: number) => ({
  adminSettings: {
    findBySettingNames: vi.fn(async () =>
      setting === null ? [] : [{ settingName: 'dataLakeMaxLakesPerUser', settingValue: setting }]
    ),
    findAll: vi.fn(async () => []),
  },
  dataLakes: { countCountedCreatedBy: vi.fn(async () => existing) },
});

describe('assertLakeCountWithinCap', () => {
  it('allows the Nth lake and refuses the N+1th with a coded 403', async () => {
    await expect(assertLakeCountWithinCap(makeDb('3', 2), 'user1')).resolves.toBeUndefined();

    const refusal = assertLakeCountWithinCap(makeDb('3', 3), 'user1');
    await expect(refusal).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assertLakeCountWithinCap(makeDb('3', 3), 'user1')).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(/limit of 3 data lakes.*delete a lake/),
      additionalInfo: { code: DATA_LAKE_LIMIT_REACHED_CODE, limit: 3 },
    });
  });

  it('counts the caller by creator id', async () => {
    const db = makeDb('3', 0);
    await assertLakeCountWithinCap(db, 'user1');
    expect(db.dataLakes.countCountedCreatedBy).toHaveBeenCalledWith('user1');
  });

  it('skips the count entirely when the cap is 0 (off)', async () => {
    const db = makeDb('0', 10_000);
    await expect(assertLakeCountWithinCap(db, 'user1')).resolves.toBeUndefined();
    expect(db.dataLakes.countCountedCreatedBy).not.toHaveBeenCalled();
  });

  it('applies the coded default when the setting is absent', async () => {
    await expect(resolveMaxLakesPerUser(makeDb(null, 0))).resolves.toBe(DATA_LAKE_MAX_LAKES_PER_USER_DEFAULT);
    await expect(
      assertLakeCountWithinCap(makeDb(null, DATA_LAKE_MAX_LAKES_PER_USER_DEFAULT), 'user1')
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('falls back to the default, never to "off", on an unusable stored value', async () => {
    const warn = vi.fn();
    await expect(resolveMaxLakesPerUser(makeDb('-4', 0), { warn })).resolves.toBe(DATA_LAKE_MAX_LAKES_PER_USER_DEFAULT);
    expect(warn).toHaveBeenCalled();
  });
});
