import { describe, it, expect, vi } from 'vitest';
import type { IAdminSettingsRepository } from '@bike4mind/common';
import { isDisposableEmail, shouldBlockDisposableEmail } from './disposableEmail';

const adminSettingsWith = (settingValue: unknown) => {
  const findBySettingName = vi.fn().mockResolvedValue(settingValue === undefined ? null : { settingValue });
  // Only findBySettingName is read by the gate.
  return { adminSettings: { findBySettingName } as unknown as IAdminSettingsRepository, findBySettingName };
};

describe('shouldBlockDisposableEmail', () => {
  it('blocks a disposable email when the setting is unset (default ON)', async () => {
    const { adminSettings } = adminSettingsWith(undefined);
    expect(await shouldBlockDisposableEmail('x@mailinator.com', { adminSettings })).toBe(true);
  });

  it('allows a disposable email when blockDisposableEmails is switched OFF', async () => {
    const { adminSettings } = adminSettingsWith('false');
    expect(await shouldBlockDisposableEmail('x@mailinator.com', { adminSettings })).toBe(false);
  });

  it('never blocks, or reads the setting for, a non-disposable email', async () => {
    const { adminSettings, findBySettingName } = adminSettingsWith(true);
    expect(await shouldBlockDisposableEmail('x@gmail.com', { adminSettings })).toBe(false);
    expect(findBySettingName).not.toHaveBeenCalled();
  });
});

describe('isDisposableEmail', () => {
  it('flags a known disposable provider', () => {
    expect(isDisposableEmail('x@mailinator.com')).toBe(true);
  });

  it('flags subdomains of a disposable provider (parent-domain match)', () => {
    expect(isDisposableEmail('x@anything.mailinator.com')).toBe(true);
  });

  it('strips a trailing FQDN dot before matching', () => {
    expect(isDisposableEmail('x@mailinator.com.')).toBe(true);
  });

  it('allows a normal provider', () => {
    expect(isDisposableEmail('x@gmail.com')).toBe(false);
  });

  it('returns false when there is no @', () => {
    expect(isDisposableEmail('notanemail')).toBe(false);
  });

  it('matches the domain after the last @ when the local part contains one', () => {
    expect(isDisposableEmail('a@b@mailinator.com')).toBe(true);
  });

  it('trims surrounding whitespace on the domain before matching', () => {
    expect(isDisposableEmail('x@  mailinator.com  ')).toBe(true);
  });

  it('returns false for an empty domain', () => {
    expect(isDisposableEmail('user@')).toBe(false);
  });

  it('is case-insensitive on the domain', () => {
    expect(isDisposableEmail('x@MAILINATOR.COM')).toBe(true);
  });
});
