import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeContributedNumberSetting, registerContributedSettings, resetContributedSettings } from '@bike4mind/common';
import { setupMongoTest } from '../../../__test__/utils';
import { AdminSettings, adminSettingsRepository } from './AdminSettingsModel';

describe('AdminSettingsRepository.getSettingsValue - MaxFileSize coercion (#2456)', () => {
  setupMongoTest();

  // This is the exact call the Slack attachment path (CommandHandler.ts) makes: a cleared
  // field is stored as '', which z.coerce.number() reads as a real 0 unless the schema's
  // `min: 1` rejects it - safeParse then fails and this repository falls back to the
  // setting's own defaultValue (30) instead of returning the coerced 0.
  it('falls back to the default when MaxFileSize is stored as a cleared empty string', async () => {
    await AdminSettings.create({ settingName: 'MaxFileSize', settingValue: '' });
    const value = await adminSettingsRepository.getSettingsValue('MaxFileSize');
    expect(value).toBe(30);
  });

  it('returns the configured value when MaxFileSize is set normally', async () => {
    await AdminSettings.create({ settingName: 'MaxFileSize', settingValue: '50' });
    const value = await adminSettingsRepository.getSettingsValue('MaxFileSize');
    expect(value).toBe(50);
  });

  it('falls back to the default when no MaxFileSize row exists at all', async () => {
    const value = await adminSettingsRepository.getSettingsValue('MaxFileSize');
    expect(value).toBe(30);
  });
});

describe('AdminSettingsRepository.getSettingsValue - contributed settings', () => {
  setupMongoTest();

  afterEach(() => resetContributedSettings());

  const register = () =>
    registerContributedSettings([
      makeContributedNumberSetting({
        key: 'extensionLimit',
        name: 'Extension limit',
        description: 'A contributed number',
        defaultValue: 7,
        min: 1,
        max: 10,
        int: true,
      }),
    ]);

  it('returns the parsed stored value of a registered contributed key', async () => {
    register();
    await AdminSettings.create({ settingName: 'extensionLimit', settingValue: '4' });
    expect(await adminSettingsRepository.getSettingsValue('extensionLimit' as never)).toBe(4);
  });

  it('returns the default when no row exists, without throwing', async () => {
    register();
    expect(await adminSettingsRepository.getSettingsValue('extensionLimit' as never)).toBe(7);
  });

  it('returns undefined for a name with no definition', async () => {
    expect(await adminSettingsRepository.getSettingsValue('nobodyRegisteredThis' as never)).toBeUndefined();
  });
});

describe('AdminSettingsRepository.getSettingsValue - enforceCredits hosted lock', () => {
  setupMongoTest();

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('resolves true on a hosted deployment without reading the stored false', async () => {
    vi.stubEnv('B4M_SELF_HOST', undefined);
    await AdminSettings.create({ settingName: 'enforceCredits', settingValue: false });
    const findOne = vi.spyOn(adminSettingsRepository, 'findOne');

    expect(await adminSettingsRepository.getSettingsValue('enforceCredits')).toBe(true);
    expect(findOne).not.toHaveBeenCalled();
  });

  it('honours a stored false on a self-host deployment', async () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    await AdminSettings.create({ settingName: 'enforceCredits', settingValue: false });

    expect(await adminSettingsRepository.getSettingsValue('enforceCredits')).toBe(false);
  });
});
