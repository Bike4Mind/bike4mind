import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ findOne: vi.fn(), updateOne: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ AdminSettings: h }));
import migration from './20260921235965_seed-staged-signup-settings';

describe('staged signup setting migration', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(['0', '37', '-2', undefined])('preserves the legacy grant %s and enables no new grants', async value => {
    h.findOne.mockResolvedValue(value === undefined ? null : { settingValue: value });
    await migration.up();
    expect(h.updateOne).toHaveBeenCalledWith(
      { settingName: 'signupGrantCredits' },
      {
        $setOnInsert: { settingName: 'signupGrantCredits', settingValue: value === '37' ? '37' : '0' },
      },
      { upsert: true }
    );
    expect(h.updateOne).toHaveBeenCalledWith(
      { settingName: 'verifiedUnlockCredits' },
      {
        $setOnInsert: { settingName: 'verifiedUnlockCredits', settingValue: '0' },
      },
      { upsert: true }
    );
    expect(h.updateOne).toHaveBeenCalledWith(
      { settingName: 'stagedSignupGrantEnabled' },
      {
        $setOnInsert: { settingName: 'stagedSignupGrantEnabled', settingValue: 'false' },
      },
      { upsert: true }
    );
  });
  it('never overwrites operator configuration on rerun or rollback', async () => {
    h.findOne.mockResolvedValue({ settingValue: '37' });
    await migration.up();
    await migration.down();
    expect(h.updateOne).toHaveBeenCalledTimes(7);
    for (const [, update] of h.updateOne.mock.calls) expect(Object.keys(update)).toEqual(['$setOnInsert']);
  });
});
