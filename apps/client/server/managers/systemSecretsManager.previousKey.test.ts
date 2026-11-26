import { describe, it, expect, beforeEach, vi } from 'vitest';
import { encryptSecret, generateEncryptionKey, configureSecretsAtRest } from '@bike4mind/utils/security';

const h = vi.hoisted(() => ({
  config: {} as { SECRET_ENCRYPTION_KEY?: string; SECRET_ENCRYPTION_KEY_PREVIOUS?: string },
  findBySecretName: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  systemSecretRepository: { findBySecretName: h.findBySecretName, findAll: vi.fn() },
  SystemSecretCategory: {},
}));
vi.mock('sst', () => ({ Resource: {} }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: h.config }));

import { clearSecretCache, getSecret, resolveSecret } from './systemSecretsManager';

describe('systemSecretsManager with a database secret stored under the previous encryption key', () => {
  let previousKey: string;

  beforeEach(() => {
    vi.clearAllMocks();
    clearSecretCache();
    previousKey = generateEncryptionKey();
    h.config.SECRET_ENCRYPTION_KEY = generateEncryptionKey();
    h.config.SECRET_ENCRYPTION_KEY_PREVIOUS = previousKey;
    configureSecretsAtRest(h.config.SECRET_ENCRYPTION_KEY, previousKey);
  });

  it('getSecret returns the decrypted database value', async () => {
    h.findBySecretName.mockResolvedValue({
      secretName: 'MAIL_HOST',
      encryptedValue: encryptSecret('smtp.example.test', previousKey),
      category: 'mail',
    });

    expect(await getSecret('MAIL_HOST')).toBe('smtp.example.test');
  });

  it('resolveSecret reports the database as the source with no warnings', async () => {
    h.findBySecretName.mockResolvedValue({
      secretName: 'MAIL_PORT',
      encryptedValue: encryptSecret('2525', previousKey),
      category: 'mail',
    });

    const result = await resolveSecret('MAIL_PORT');

    expect(result).toEqual({ value: '2525', source: 'database', warnings: undefined });
  });

  it('falls back to no value with a warning when the stored secret matches neither key', async () => {
    h.findBySecretName.mockResolvedValue({
      secretName: 'MAIL_USER',
      encryptedValue: encryptSecret('mailer', generateEncryptionKey()),
      category: 'mail',
    });

    const result = await resolveSecret('MAIL_USER');

    expect(result.value).toBeUndefined();
    expect(result.warnings?.[0]).toContain('Failed to decrypt MAIL_USER');
  });
});
