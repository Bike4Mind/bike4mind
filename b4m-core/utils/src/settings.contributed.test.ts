import { afterEach, describe, expect, it } from 'vitest';
import {
  makeContributedBooleanSetting,
  makeContributedNumberSetting,
  registerContributedSettings,
  resetContributedSettings,
} from '@bike4mind/common';
import { getContributedSettingValue, getSettingsValue } from './settings';

afterEach(() => resetContributedSettings());

describe('getContributedSettingValue', () => {
  it('parses a registered key through its own schema and falls back to its default', () => {
    registerContributedSettings([
      makeContributedBooleanSetting({ key: 'ExtensionFlag', name: 'x', description: 'x', defaultValue: false }),
      makeContributedNumberSetting({ key: 'extensionLimit', name: 'x', description: 'x', defaultValue: 7, max: 10 }),
    ]);
    expect(getContributedSettingValue('ExtensionFlag', { ExtensionFlag: 'true' })).toBe(true);
    expect(getContributedSettingValue('extensionLimit', { extensionLimit: '4' })).toBe(4);
    expect(getContributedSettingValue('extensionLimit', {})).toBe(7);
    expect(getContributedSettingValue('extensionLimit', { extensionLimit: '99' })).toBe(7);
    expect(getContributedSettingValue('extensionLimit', { extensionLimit: '99' }, 3)).toBe(3);
  });

  it('returns the caller default for a key nobody registered', () => {
    expect(getContributedSettingValue('unregisteredKey', { unregisteredKey: 'true' }, 'fallback')).toBe('fallback');
    expect(getContributedSettingValue('unregisteredKey', {})).toBeUndefined();
  });

  it('leaves core keys on the core definition', () => {
    expect(getSettingsValue('lowCreditsThreshold', { lowCreditsThreshold: '250' })).toBe(250);
  });
});
