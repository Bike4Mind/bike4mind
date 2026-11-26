import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const configValues = vi.hoisted((): Record<string, string | undefined> => ({
  MAIL_HOST: 'smtp.example.com',
  MAIL_PORT: '465',
  MAIL_USERNAME: 'user@example.com',
  MAIL_PASSWORD: 'secret',
  MAIL_FROM: 'noreply@example.com',
}));

vi.mock('../config', () => ({ Config: configValues }));

import { getMailConfigStatus, requiredMailSecrets, statusTransportKind, unusedMailSecrets } from './configStatus';

const SMTP_KEYS = ['MAIL_HOST', 'MAIL_PORT', 'MAIL_USERNAME', 'MAIL_PASSWORD', 'MAIL_FROM'];

describe('getMailConfigStatus', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    Object.assign(configValues, {
      MAIL_HOST: 'smtp.example.com',
      MAIL_PORT: '465',
      MAIL_USERNAME: 'user@example.com',
      MAIL_PASSWORD: 'secret',
      MAIL_FROM: 'noreply@example.com',
    });
  });

  it('reports SES as configured with only the sender when the SMTP secrets are placeholders', () => {
    configValues.MAIL_HOST = 'not-configured';
    configValues.MAIL_PORT = 'not-configured';
    configValues.MAIL_USERNAME = 'not-configured';
    configValues.MAIL_PASSWORD = 'not-configured';

    const status = getMailConfigStatus('ses');

    expect(status).toEqual({
      configured: true,
      transport: 'ses',
      missingSecrets: [],
      optionalSecrets: [],
      secrets: { MAIL_FROM: true },
      senderSource: 'secret',
    });
  });

  it('reports SES as unconfigured without a sender', () => {
    configValues.MAIL_FROM = '';

    const status = getMailConfigStatus('ses');
    expect(status).toMatchObject({ configured: false, missingSecrets: ['MAIL_FROM'] });
    expect(status.senderSource).toBeUndefined();
  });

  it.each(['ses', 'smtp'] as const)('counts a sender from the admin setting on %s when the secret is unset', kind => {
    configValues.MAIL_FROM = 'not-configured';

    const status = getMailConfigStatus(kind, true);

    expect(status.configured).toBe(true);
    expect(status.missingSecrets).not.toContain('MAIL_FROM');
    expect(status.secrets.MAIL_FROM).toBe(true);
    expect(status.senderSource).toBe('setting');
  });

  it('names the setting as the source when both hold a sender', () => {
    expect(getMailConfigStatus('ses', true).senderSource).toBe('setting');
  });

  it('names every required SMTP setting when none is set, leaving the credentials optional', () => {
    for (const key of SMTP_KEYS) Object.assign(configValues, { [key]: 'not-configured' });

    const status = getMailConfigStatus('smtp');

    expect(status.configured).toBe(false);
    expect(status.missingSecrets).toEqual(['MAIL_HOST', 'MAIL_PORT', 'MAIL_FROM']);
    expect(status.optionalSecrets).toEqual(['MAIL_USERNAME', 'MAIL_PASSWORD']);
    expect(Object.keys(status.secrets)).toEqual(SMTP_KEYS);
    expect(Object.values(status.secrets)).toEqual([false, false, false, false, false]);
  });

  it('reports SMTP as configured when every secret is real', () => {
    const status = getMailConfigStatus('smtp');

    expect(status.configured).toBe(true);
    expect(status.secrets).toEqual(Object.fromEntries(SMTP_KEYS.map(key => [key, true])));
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['placeholder', 'not-configured'],
  ])('reports a self-host SMTP relay without auth as configured when both credentials are %s', (_label, value) => {
    Object.assign(configValues, { MAIL_USERNAME: value, MAIL_PASSWORD: value });

    const status = getMailConfigStatus('smtp');

    expect(status.configured).toBe(true);
    expect(status.missingSecrets).toEqual([]);
    expect(status.optionalSecrets).toEqual(['MAIL_USERNAME', 'MAIL_PASSWORD']);
    expect(status.secrets).toMatchObject({ MAIL_USERNAME: false, MAIL_PASSWORD: false });
  });

  it.each([
    ['unset', undefined],
    ['placeholder', 'my-secret-placeholder-value'],
  ])('keeps flagging both credentials on a hosted stage when they are %s', (_label, value) => {
    vi.stubEnv('B4M_SELF_HOST', '');
    Object.assign(configValues, { MAIL_USERNAME: value, MAIL_PASSWORD: value });

    const status = getMailConfigStatus('smtp');

    expect(status.configured).toBe(false);
    expect(status.missingSecrets).toEqual(['MAIL_USERNAME', 'MAIL_PASSWORD']);
    expect(status.optionalSecrets).toEqual([]);
  });

  it.each([
    ['MAIL_USERNAME', 'MAIL_PASSWORD'],
    ['MAIL_PASSWORD', 'MAIL_USERNAME'],
  ])('flags the missing partner when only %s is set', (setKey, unsetKey) => {
    Object.assign(configValues, { [setKey]: 'value', [unsetKey]: '  ' });

    const status = getMailConfigStatus('smtp');

    expect(status.configured).toBe(false);
    expect(status.missingSecrets).toEqual([unsetKey]);
    expect(status.optionalSecrets).toEqual([]);
  });

  it('never marks the credentials optional on SES', () => {
    Object.assign(configValues, { MAIL_USERNAME: '', MAIL_PASSWORD: '' });

    expect(getMailConfigStatus('ses')).toMatchObject({ configured: true, missingSecrets: [], optionalSecrets: [] });
  });

  it('defaults to the status transport from the environment', () => {
    vi.stubEnv('MAIL_STATUS_TRANSPORT', 'ses');
    vi.stubEnv('B4M_SELF_HOST', '');
    try {
      expect(getMailConfigStatus().transport).toBe('ses');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('requiredMailSecrets', () => {
  it('needs only the sender on SES and the whole set on SMTP', () => {
    expect(requiredMailSecrets('ses')).toEqual(['MAIL_FROM']);
    expect(requiredMailSecrets('smtp')).toEqual(SMTP_KEYS);
  });
});

describe('unusedMailSecrets', () => {
  it('names the four SMTP settings on SES and nothing on SMTP', () => {
    expect(unusedMailSecrets('ses')).toEqual(['MAIL_HOST', 'MAIL_PORT', 'MAIL_USERNAME', 'MAIL_PASSWORD']);
    expect(unusedMailSecrets('smtp')).toEqual([]);
  });
});

describe('statusTransportKind', () => {
  it.each([
    [{ MAIL_STATUS_TRANSPORT: 'ses' }, 'ses'],
    [{ MAIL_STATUS_TRANSPORT: ' SES ' }, 'ses'],
    [{ MAIL_STATUS_TRANSPORT: '', MAIL_TRANSPORT: 'ses' }, 'smtp'],
    [{ MAIL_STATUS_TRANSPORT: 'smtp', MAIL_TRANSPORT: 'ses' }, 'smtp'],
    [{ MAIL_TRANSPORT: 'ses' }, 'ses'],
    [{}, 'smtp'],
    [{ B4M_SELF_HOST: 'true', MAIL_STATUS_TRANSPORT: 'ses' }, 'smtp'],
    [{ B4M_SELF_HOST: 'true', MAIL_TRANSPORT: 'ses' }, 'smtp'],
  ])('resolves %o to %s', (env, expected) => {
    expect(statusTransportKind(env)).toBe(expected);
  });
});
