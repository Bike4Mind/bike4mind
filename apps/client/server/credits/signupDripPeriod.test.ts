import { beforeEach, describe, expect, it, vi } from 'vitest';

const setting = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: { findBySettingName: setting } }));
import { resolveSignupDripPeriod } from './signupDripPeriod';

const now = new Date('2030-03-01T10:02:30Z');
const daily = { day: '2030-03-01', endsAt: Date.parse('2030-03-02T00:00:00Z') };

beforeEach(() => {
  setting.mockReset().mockResolvedValue({ settingValue: true });
});

describe('signup drip preview test mode', () => {
  it.each(['production', 'dev', 'staging', 'shared-dev', 'personal', 'pr', 'pr6157-extra'])(
    'ignores the switch entirely on %s',
    async stage => {
      expect(await resolveSignupDripPeriod(now, stage)).toEqual(daily);
      expect(setting).not.toHaveBeenCalled();
    }
  );

  it.each([true, 'true'])('uses five-minute windows on a PR preview when enabled with %s', async value => {
    setting.mockResolvedValue({ settingValue: value });
    const period = await resolveSignupDripPeriod(now, 'pr6157');
    expect(period).toEqual({
      day: '2030-03-01',
      key: `preview:5:${Math.floor(now.getTime() / 300_000)}`,
      endsAt: Date.parse('2030-03-01T10:05:00Z'),
    });
    expect(setting).toHaveBeenCalledWith('signupGrantActivityPreviewTestMode');
    expect((await resolveSignupDripPeriod(new Date('2030-03-01T10:04:59Z'), 'pr6157')).key).toBe(period.key);
    expect((await resolveSignupDripPeriod(new Date('2030-03-01T10:05:00Z'), 'pr6157')).key).not.toBe(period.key);
  });

  it.each([false, 'false', undefined, 'invalid'])(
    'keeps UTC days with a disabled, absent or invalid setting (%s)',
    async value => {
      setting.mockResolvedValue({ settingValue: value });
      expect(await resolveSignupDripPeriod(now, 'pr6157')).toEqual(daily);
    }
  );

  it('propagates a failed settings read instead of changing the payout cadence silently', async () => {
    setting.mockRejectedValue(new Error('settings unavailable'));
    await expect(resolveSignupDripPeriod(now, 'pr6157')).rejects.toThrow('settings unavailable');
  });
});
