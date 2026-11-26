import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const configValues = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: configValues }));
const findSetting = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: { findOne: findSetting } }));
vi.mock('@server/auth/oktaOidcClient', () => ({
  getOktaConfigStatus: vi.fn(async () => ({
    sstConfigured: false,
    databaseConfigured: false,
    effectiveSource: 'none',
    effectiveConfig: null,
  })),
}));
vi.mock('@server/security/tier1SecretValidators', () => ({
  validateJwtSecret: () => ({ isValid: true, status: 'valid' }),
  validateEncryptionKey: () => ({ isValid: true, status: 'valid' }),
}));

import { getSystemHealthStatus } from './getSystemHealthStatus';

const ENV_KEYS = [
  'MAIL_STATUS_TRANSPORT',
  'MAIL_TRANSPORT',
  'B4M_SELF_HOST',
  'B4M_ALLOW_PLAINTEXT_SECRETS',
  'SECRET_ENCRYPTION_KEY',
] as const;

describe('getSystemHealthStatus email', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    for (const key of Object.keys(configValues)) delete configValues[key];
    findSetting.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('flags the plaintext opt-out only when it is set and no valid key exists', async () => {
    expect((await getSystemHealthStatus()).plaintextSecretsOptOut).toBe(false);

    process.env.B4M_ALLOW_PLAINTEXT_SECRETS = 'true';
    expect((await getSystemHealthStatus()).plaintextSecretsOptOut).toBe(true);

    process.env.SECRET_ENCRYPTION_KEY = 'a'.repeat(64);
    expect((await getSystemHealthStatus()).plaintextSecretsOptOut).toBe(false);
  });

  it('reports an SES stage as configured with only MAIL_FROM when the SMTP secrets are placeholders', async () => {
    process.env.MAIL_STATUS_TRANSPORT = 'ses';
    Object.assign(configValues, {
      MAIL_HOST: 'not-configured',
      MAIL_PORT: 'not-configured',
      MAIL_USERNAME: 'not-configured',
      MAIL_PASSWORD: 'not-configured',
      MAIL_FROM: 'noreply@example.com',
    });

    const { email } = await getSystemHealthStatus();

    expect(email).toEqual({
      configured: true,
      transport: 'ses',
      missingSecrets: [],
      optionalSecrets: [],
      secrets: { MAIL_FROM: true },
      senderSource: 'secret',
    });
  });

  it('counts the mailFrom admin setting as the sender when the MAIL_FROM secret is unset', async () => {
    process.env.MAIL_STATUS_TRANSPORT = 'ses';
    configValues.MAIL_FROM = 'not-configured';
    findSetting.mockResolvedValue({ settingName: 'mailFrom', settingValue: 'Ops <ops@example.com>' });

    const { email } = await getSystemHealthStatus();

    expect(email).toMatchObject({ configured: true, missingSecrets: [], senderSource: 'setting' });
    expect(JSON.stringify(email)).not.toContain('@');
  });

  it('names the SMTP settings on a self-host deploy even when the status transport says ses', async () => {
    process.env.B4M_SELF_HOST = 'true';
    process.env.MAIL_STATUS_TRANSPORT = 'ses';
    configValues.MAIL_FROM = 'noreply@example.com';

    const { email } = await getSystemHealthStatus();

    expect(email.configured).toBe(false);
    expect(email.transport).toBe('smtp');
    expect(email.missingSecrets).toEqual(['MAIL_HOST', 'MAIL_PORT']);
    expect(email.optionalSecrets).toEqual(['MAIL_USERNAME', 'MAIL_PASSWORD']);
  });

  it('reports selfHost from B4M_SELF_HOST', async () => {
    expect((await getSystemHealthStatus()).selfHost).toBe(false);

    process.env.B4M_SELF_HOST = 'true';
    expect((await getSystemHealthStatus()).selfHost).toBe(true);
  });
});
