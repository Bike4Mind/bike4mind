import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const findSetting = vi.hoisted(() => vi.fn());
const config = vi.hoisted(() => ({ TURNSTILE_SECRET_KEY: 'secret' as string | undefined }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { findBySettingName: findSetting },
}));
const deployed = vi.hoisted(() => ({ value: false }));
const warn = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: config, isDeployedStage: () => deployed.value }));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    warn = warn;
  },
}));

import {
  TURNSTILE_INACTIVE_LOG_INTERVAL_MS,
  getTurnstilePolicy,
  getTurnstileStepUpPolicy,
  turnstileAllowedHostnames,
  type TurnstileInactiveReason,
} from './turnstile';

describe('getTurnstilePolicy', () => {
  beforeEach(() => {
    findSetting.mockReset();
    config.TURNSTILE_SECRET_KEY = 'secret';
    const settings: Record<string, unknown> = {
      turnstileEnabled: true,
      turnstileFailClosed: true,
      turnstileSiteKey: ' site ',
    };
    findSetting.mockImplementation(async (key: string) => ({ settingValue: settings[key] }));
  });

  it('resolves the persisted policy and trims the public key', async () => {
    expect(await getTurnstilePolicy()).toEqual({ active: true, failClosed: true, siteKey: 'site', secret: 'secret' });
  });

  it('defaults to inactive only when settings are absent', async () => {
    findSetting.mockResolvedValue(null);
    expect(await getTurnstilePolicy()).toMatchObject({ active: false, failClosed: false, siteKey: '' });
  });

  it('skips dependent reads when the toggle is off', async () => {
    findSetting.mockImplementation(async (key: string) => {
      if (key !== 'turnstileEnabled') throw new Error('must not read disabled policy');
      return { settingValue: false };
    });
    expect(await getTurnstilePolicy()).toMatchObject({ active: false });
    expect(findSetting).toHaveBeenCalledExactlyOnceWith('turnstileEnabled');
  });

  it.each(['turnstileEnabled', 'turnstileFailClosed', 'turnstileSiteKey'])(
    'propagates a failed read of %s instead of disabling the gate',
    async failedKey => {
      findSetting.mockImplementation(async (key: string) => {
        if (key === failedKey) throw new Error('settings unavailable');
        return { settingValue: key === 'turnstileSiteKey' ? 'site' : true };
      });
      await expect(getTurnstilePolicy()).rejects.toThrow('settings unavailable');
    }
  );

  it('rejects malformed persisted settings instead of disabling the gate', async () => {
    findSetting.mockResolvedValue({ settingValue: {} });
    await expect(getTurnstilePolicy()).rejects.toThrow();
  });

  it.each([undefined, '', 'not-configured'])('keeps an unprovisioned stage inactive: %s', async secret => {
    config.TURNSTILE_SECRET_KEY = secret;
    findSetting.mockRejectedValue(new Error('database unavailable'));
    expect(await getTurnstilePolicy()).toMatchObject({ active: false, secret: '' });
    expect(findSetting).not.toHaveBeenCalled();
  });
});

describe('getTurnstileStepUpPolicy', () => {
  const settings: Record<string, unknown> = {};
  beforeEach(() => {
    findSetting.mockReset();
    config.TURNSTILE_SECRET_KEY = 'secret';
    Object.assign(settings, { turnstileEnabled: false, turnstileFailClosed: false, turnstileSiteKey: ' site ' });
    findSetting.mockImplementation(async (key: string) => ({ settingValue: settings[key] }));
  });

  it('is active with a site key while the always-on toggle is off', async () => {
    expect(await getTurnstileStepUpPolicy()).toEqual({
      active: true,
      failClosed: false,
      siteKey: 'site',
      secret: 'secret',
    });
  });

  it('stays inactive while every request is already challenged', async () => {
    settings.turnstileEnabled = true;
    expect(await getTurnstileStepUpPolicy()).toMatchObject({ active: false });
  });

  it('stays inactive without a site key or a provisioned secret', async () => {
    settings.turnstileSiteKey = ' ';
    expect(await getTurnstileStepUpPolicy()).toMatchObject({ active: false });
    config.TURNSTILE_SECRET_KEY = undefined;
    settings.turnstileSiteKey = 'site';
    expect(await getTurnstileStepUpPolicy()).toMatchObject({ active: false, secret: '' });
  });
});

describe('inactive policy warning', () => {
  let clock = Date.now();
  const settingsFor = (overrides: Record<string, unknown>) => {
    const settings: Record<string, unknown> = {
      turnstileEnabled: true,
      turnstileFailClosed: true,
      turnstileSiteKey: 'site',
      ...overrides,
    };
    findSetting.mockImplementation(async (key: string) => ({ settingValue: settings[key] }));
  };
  const inactive: Record<TurnstileInactiveReason, () => void> = {
    'secret-not-configured': () => {
      config.TURNSTILE_SECRET_KEY = undefined;
    },
    disabled: () => settingsFor({ turnstileEnabled: false }),
    'site-key-empty': () => settingsFor({ turnstileSiteKey: '  ' }),
  };
  const reasons = Object.keys(inactive) as TurnstileInactiveReason[];

  beforeEach(() => {
    vi.useFakeTimers();
    // The throttle is module state; a later clock per test keeps every test clear of earlier warnings.
    clock += 10 * TURNSTILE_INACTIVE_LOG_INTERVAL_MS;
    vi.setSystemTime(clock);
    warn.mockReset();
    findSetting.mockReset();
    config.TURNSTILE_SECRET_KEY = 'secret';
    deployed.value = true;
    settingsFor({});
  });
  afterEach(() => {
    vi.useRealTimers();
    deployed.value = false;
  });

  it.each(reasons)('stays silent off a deployed stage: %s', async reason => {
    deployed.value = false;
    inactive[reason]();
    expect(await getTurnstilePolicy()).toMatchObject({ active: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(reasons)('logs the reason once on a deployed stage: %s', async reason => {
    inactive[reason]();
    expect(await getTurnstilePolicy()).toMatchObject({ active: false });
    expect(warn).toHaveBeenCalledExactlyOnceWith('turnstile-policy-inactive', { reason });
  });

  it.each(reasons)('does not repeat within the interval: %s', async reason => {
    inactive[reason]();
    await getTurnstilePolicy();
    await getTurnstilePolicy();
    vi.advanceTimersByTime(TURNSTILE_INACTIVE_LOG_INTERVAL_MS - 1);
    await getTurnstilePolicy();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each(reasons)('logs again once the interval has passed: %s', async reason => {
    inactive[reason]();
    await getTurnstilePolicy();
    vi.advanceTimersByTime(TURNSTILE_INACTIVE_LOG_INTERVAL_MS);
    await getTurnstilePolicy();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith('turnstile-policy-inactive', { reason });
  });

  it('logs nothing for an active policy', async () => {
    expect(await getTurnstilePolicy()).toMatchObject({ active: true });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('turnstileAllowedHostnames', () => {
  it('combines normalized explicit hosts with the app hostname', () => {
    vi.stubEnv('APP_URL', 'https://APP.example.com:443/path');
    vi.stubEnv('TURNSTILE_ALLOWED_HOSTNAMES', ' preview.example.com, , EXTRA.example.com ');
    try {
      expect(turnstileAllowedHostnames()).toEqual(['preview.example.com', 'extra.example.com', 'app.example.com']);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
