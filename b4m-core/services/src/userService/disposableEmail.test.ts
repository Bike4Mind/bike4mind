import { describe, it, expect, vi } from 'vitest';
import type { IAdminSettingsRepository } from '@bike4mind/common';
import {
  createSignupEmailGate,
  isAdminBlockedEmailDomain,
  isDisposableEmail,
  shouldBlockDisposableEmail,
} from './disposableEmail';

const adminSettingsWith = (settings: Record<string, unknown>) => {
  const findBySettingName = vi.fn(async (name: string) =>
    name in settings ? { settingName: name, settingValue: settings[name] } : null
  );
  // Only findBySettingName is read by the gate.
  return { adminSettings: { findBySettingName } as unknown as IAdminSettingsRepository, findBySettingName };
};

describe('shouldBlockDisposableEmail', () => {
  it('blocks a disposable email when the setting is unset (default ON)', async () => {
    const { adminSettings } = adminSettingsWith({});
    expect(await shouldBlockDisposableEmail('x@mailinator.com', { adminSettings })).toBe(true);
  });

  it('allows a disposable email when blockDisposableEmails is switched OFF', async () => {
    const { adminSettings } = adminSettingsWith({ blockDisposableEmails: 'false' });
    expect(await shouldBlockDisposableEmail('x@mailinator.com', { adminSettings })).toBe(false);
  });

  it('never blocks, or reads the disposable toggle for, an email on no list', async () => {
    const { adminSettings, findBySettingName } = adminSettingsWith({ blockDisposableEmails: true });
    expect(await shouldBlockDisposableEmail('x@gmail.com', { adminSettings })).toBe(false);
    expect(findBySettingName).not.toHaveBeenCalledWith('blockDisposableEmails');
  });

  it('blocks a subdomain of an admin-blocked domain', async () => {
    const { adminSettings } = adminSettingsWith({ blockedEmailDomains: JSON.stringify(['kashre.com']) });
    expect(await shouldBlockDisposableEmail('x@np.kashre.com', { adminSettings })).toBe(true);
  });

  it('blocks a domain on both lists when blockDisposableEmails is OFF', async () => {
    const { adminSettings } = adminSettingsWith({
      blockDisposableEmails: false,
      blockedEmailDomains: ['mailinator.com'],
    });
    expect(await shouldBlockDisposableEmail('x@mailinator.com', { adminSettings })).toBe(true);
  });

  it('blocks an admin-blocked domain even when blockDisposableEmails is OFF', async () => {
    const { adminSettings } = adminSettingsWith({ blockDisposableEmails: false, blockedEmailDomains: ['kashre.com'] });
    expect(await shouldBlockDisposableEmail('x@kashre.com', { adminSettings })).toBe(true);
  });
});

describe('isAdminBlockedEmailDomain', () => {
  it('is false when the setting is unset', async () => {
    const { adminSettings } = adminSettingsWith({});
    expect(await isAdminBlockedEmailDomain('x@kashre.com', { adminSettings })).toBe(false);
  });

  it('matches entries case-insensitively and ignores invalid stored entries', async () => {
    const { adminSettings } = adminSettingsWith({ blockedEmailDomains: ['not a domain', ' KASHRE.com '] });
    expect(await isAdminBlockedEmailDomain('X@NP.Kashre.COM', { adminSettings })).toBe(true);
  });

  it('does not match a domain that only ends with the same letters', async () => {
    const { adminSettings } = adminSettingsWith({ blockedEmailDomains: ['kashre.com'] });
    expect(await isAdminBlockedEmailDomain('x@notkashre.com', { adminSettings })).toBe(false);
  });

  it('is false for a stored value that is not a list', async () => {
    const { adminSettings } = adminSettingsWith({ blockedEmailDomains: 'kashre.com' });
    expect(await isAdminBlockedEmailDomain('x@kashre.com', { adminSettings })).toBe(false);
  });
});

describe('createSignupEmailGate', () => {
  const gateWith = async (settings: Record<string, unknown>) => {
    const findBySettingNames = vi.fn(async (names: string[]) =>
      names.filter(name => name in settings).map(name => ({ settingName: name, settingValue: settings[name] }))
    );
    const gate = await createSignupEmailGate({ findBySettingNames } as unknown as IAdminSettingsRepository);
    return { gate, findBySettingNames };
  };

  it('reads the settings once and checks many emails without further reads', async () => {
    const { gate, findBySettingNames } = await gateWith({ blockedEmailDomains: ['kashre.com'] });
    expect(gate('x@np.kashre.com')).toBe(true);
    expect(gate('x@mailinator.com')).toBe(true);
    expect(gate('x@gmail.com')).toBe(false);
    expect(findBySettingNames).toHaveBeenCalledTimes(1);
  });

  it('allows a disposable email but still blocks the admin list when blockDisposableEmails is OFF', async () => {
    const { gate } = await gateWith({ blockDisposableEmails: 'false', blockedEmailDomains: ['kashre.com'] });
    expect(gate('x@mailinator.com')).toBe(false);
    expect(gate('x@kashre.com')).toBe(true);
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
