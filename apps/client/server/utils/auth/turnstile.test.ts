import { beforeEach, describe, expect, it, vi } from 'vitest';

const findSetting = vi.hoisted(() => vi.fn());
const config = vi.hoisted(() => ({ TURNSTILE_SECRET_KEY: 'secret' as string | undefined }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { findBySettingName: findSetting },
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: config }));

import { getTurnstilePolicy, getTurnstileStepUpPolicy, turnstileAllowedHostnames } from './turnstile';

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
