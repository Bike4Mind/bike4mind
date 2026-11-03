import { describe, it, expect, vi } from 'vitest';
import type { IAdminSettingsRepository, SignupProtection } from '@bike4mind/common';
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

describe('shouldBlockDisposableEmail with refreshed lists', () => {
  const protectionWith = (sources: Record<string, ('aggregate' | 'curated' | 'fakefilter')[]>) =>
    ({
      repository: {
        disposableSources: vi.fn(async (domains: string[]) => domains.flatMap(domain => sources[domain] ?? [])),
        isOrganizationDomain: vi.fn(async (email: string) => email.endsWith('@customer-org.test')),
      },
    }) as unknown as SignupProtection;

  it('rejects a reject-tier domain, including a rotated subdomain under it', async () => {
    const { adminSettings } = adminSettingsWith({});
    const signupProtection = protectionWith({ 'example-burner.test': ['aggregate', 'fakefilter'] });
    expect(await shouldBlockDisposableEmail('x@q9.example-burner.test', { adminSettings, signupProtection })).toBe(
      true
    );
  });

  it('leaves an aggregate-only domain to the hold layer', async () => {
    const { adminSettings } = adminSettingsWith({});
    const signupProtection = protectionWith({ 'aggregate-only.test': ['aggregate'] });
    expect(await shouldBlockDisposableEmail('x@aggregate-only.test', { adminSettings, signupProtection })).toBe(false);
  });

  it('honours the blockDisposableEmails toggle for refreshed lists', async () => {
    const { adminSettings } = adminSettingsWith({ blockDisposableEmails: 'false' });
    const signupProtection = protectionWith({ 'curated-burner.test': ['curated'] });
    expect(await shouldBlockDisposableEmail('x@curated-burner.test', { adminSettings, signupProtection })).toBe(false);
  });

  it('never rejects an organization or internal staff domain on a refreshed-list hit', async () => {
    vi.stubEnv('NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS', 'staff-co.test');
    const { adminSettings } = adminSettingsWith({});
    const signupProtection = protectionWith({ 'customer-org.test': ['fakefilter'], 'staff-co.test': ['curated'] });
    expect(await shouldBlockDisposableEmail('x@customer-org.test', { adminSettings, signupProtection })).toBe(false);
    expect(await shouldBlockDisposableEmail('x@staff-co.test', { adminSettings, signupProtection })).toBe(false);
    vi.unstubAllEnvs();
  });

  it('skips the list read when blockDisposableEmails is OFF, so a DB error cannot block', async () => {
    const { adminSettings } = adminSettingsWith({ blockDisposableEmails: 'false' });
    const signupProtection = {
      repository: { disposableSources: vi.fn().mockRejectedValue(new Error('db down')) },
    } as unknown as SignupProtection;
    expect(await shouldBlockDisposableEmail('x@unknown.test', { adminSettings, signupProtection })).toBe(false);
  });

  it('fails closed when the list read throws', async () => {
    const { adminSettings } = adminSettingsWith({});
    const signupProtection = {
      repository: { disposableSources: vi.fn().mockRejectedValue(new Error('db down')) },
    } as unknown as SignupProtection;
    await expect(shouldBlockDisposableEmail('x@unknown.test', { adminSettings, signupProtection })).rejects.toThrow();
  });
});
