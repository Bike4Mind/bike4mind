import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const configValues = vi.hoisted((): Record<string, string | undefined> => ({ MAIL_FROM: 'noreply@example.com' }));
vi.mock('../config', () => ({ Config: configValues }));

const findSetting = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: { findOne: findSetting } }));

vi.mock('@bike4mind/observability', () => ({ Logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { Logger } from '@bike4mind/observability';
import { loadMailConfigStatus, mailSenderSettingProblem, parseMailSender, resolveMailSender } from './sender';

const storeSetting = (settingValue: unknown) =>
  findSetting.mockResolvedValue({ settingName: 'mailFrom', settingValue });

describe('parseMailSender', () => {
  it.each([
    ['noreply@example.com', 'noreply@example.com'],
    ['Ops Team <ops@example.com>', 'ops@example.com'],
    ['"Ops, Team" <ops@example.com>', 'ops@example.com'],
  ])('reads %j as one sender', (value, address) => {
    expect(parseMailSender(value)).toBe(address);
  });

  it.each([
    ['two addresses', 'a@example.com, b@example.com'],
    ['a group', 'Team: a@example.com;'],
    ['no address', 'Ops Team'],
    ['no domain', 'noreply@'],
    ['no local part', '@example.com'],
    ['an address in the name', '<a@example.com> <b@example.com>'],
    ['a line break', 'noreply@example.com\r\nBcc: x@example.com'],
    ['too long', `${'a'.repeat(320)}@example.com`],
  ])('rejects %s', (_label, value) => {
    expect(parseMailSender(value)).toBeUndefined();
  });
});

describe('mailSenderSettingProblem', () => {
  const ses = { transport: 'ses' as const, secretFrom: 'Example <noreply@example.com>' };

  it.each(['', '   '])('accepts the blank value %j, which clears the setting', value => {
    expect(mailSenderSettingProblem(value, ses)).toBeUndefined();
  });

  it('accepts a sender on the MAIL_FROM domain on SES, in any case', () => {
    expect(mailSenderSettingProblem('Support <support@Example.com>', ses)).toBeUndefined();
  });

  it('rejects a line break', () => {
    expect(mailSenderSettingProblem('a@example.com\nBcc: b@example.com', ses)).toBe('The sender must be on one line.');
  });

  it('rejects an overlong value', () => {
    expect(mailSenderSettingProblem(`${'a'.repeat(320)}@example.com`, ses)).toContain('at most 320 characters');
  });

  it.each(['a@example.com, b@example.com', 'Ops Team', 'Team: a@example.com;'])(
    'rejects %j as not one sender',
    value => {
      expect(mailSenderSettingProblem(value, ses)).toContain('Enter one sender');
    }
  );

  it.each(['noreply@other.com', 'noreply@mail.example.com'])(
    'rejects %j on SES because it is off the MAIL_FROM domain',
    value => {
      expect(mailSenderSettingProblem(value, ses)).toContain('domain of the MAIL_FROM secret (example.com)');
    }
  );

  it('allows any domain on SMTP', () => {
    expect(mailSenderSettingProblem('noreply@other.com', { ...ses, transport: 'smtp' })).toBeUndefined();
  });

  it.each([undefined, '', 'not-configured'])('allows any domain on SES while the secret is %j', secretFrom => {
    expect(mailSenderSettingProblem('noreply@other.com', { transport: 'ses', secretFrom })).toBeUndefined();
  });
});

describe('resolveMailSender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configValues.MAIL_FROM = 'noreply@example.com';
    findSetting.mockResolvedValue(null);
  });

  it('uses the setting when it holds a valid sender', async () => {
    storeSetting(' Ops Team <ops@example.com> ');
    await expect(resolveMailSender()).resolves.toEqual({ from: 'Ops Team <ops@example.com>', source: 'setting' });
    expect(findSetting).toHaveBeenCalledWith({ settingName: 'mailFrom' });
  });

  it.each([
    ['no row', null],
    ['an empty value', { settingName: 'mailFrom', settingValue: '' }],
    ['a blank value', { settingName: 'mailFrom', settingValue: '  ' }],
  ])('uses the secret when the setting has %s, without a warning', async (_label, row) => {
    findSetting.mockResolvedValue(row);
    await expect(resolveMailSender()).resolves.toEqual({ from: 'noreply@example.com', source: 'secret' });
    expect(Logger.warn).not.toHaveBeenCalled();
  });

  it.each(['two@example.com, senders@example.com', 'ops@example.com\r\nBcc: x@example.com'])(
    'falls back to the secret on the invalid stored value %j and keeps it out of the warning',
    async value => {
      storeSetting(value);
      await expect(resolveMailSender()).resolves.toEqual({ from: 'noreply@example.com', source: 'secret' });
      expect(Logger.warn).toHaveBeenCalledOnce();
      expect(JSON.stringify(vi.mocked(Logger.warn).mock.calls)).not.toContain('@');
    }
  );

  it('falls back to the secret when the setting cannot be read', async () => {
    findSetting.mockRejectedValue(new Error('db down'));
    await expect(resolveMailSender()).resolves.toEqual({ from: 'noreply@example.com', source: 'secret' });
    expect(Logger.warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });
});

describe('loadMailConfigStatus', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    findSetting.mockResolvedValue(null);
  });

  it('reports the setting as the source and counts mail as configured without the secret', async () => {
    configValues.MAIL_FROM = 'not-configured';
    storeSetting('ops@example.com');

    const status = await loadMailConfigStatus('ses');

    expect(status).toMatchObject({ configured: true, missingSecrets: [], senderSource: 'setting' });
  });

  it('reports the secret as the source when the setting is empty', async () => {
    configValues.MAIL_FROM = 'noreply@example.com';

    expect((await loadMailConfigStatus('ses')).senderSource).toBe('secret');
  });

  it('reports mail as unconfigured when neither holds a sender', async () => {
    configValues.MAIL_FROM = 'not-configured';

    const status = await loadMailConfigStatus('ses');

    expect(status).toMatchObject({ configured: false, missingSecrets: ['MAIL_FROM'] });
    expect(status.senderSource).toBeUndefined();
  });

  it('describes the status transport by default', async () => {
    vi.stubEnv('MAIL_STATUS_TRANSPORT', 'ses');
    vi.stubEnv('B4M_SELF_HOST', '');

    expect((await loadMailConfigStatus()).transport).toBe('ses');
  });
});
