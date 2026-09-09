import { describe, it, expect, beforeAll } from 'vitest';
import { ApiKeyType } from '@bike4mind/common';
import { configureSecretsAtRest, generateEncryptionKey, isEncrypted } from '@bike4mind/utils/security';
import { setupMongoTest } from '../../__test__/utils';
import { ApiKey, apiKeyRepository } from './ApiKeyModel';

const KEY = generateEncryptionKey();

describe('ApiKeyRepository encrypt-on-write / decrypt-on-read', () => {
  setupMongoTest();

  beforeAll(() => {
    configureSecretsAtRest(KEY);
  });

  // setupMongoTest drops the DB before each `it`, but each test also uses a distinct userId so
  // the assertions never depend on that reset scoping (findByUserIdAndType is an unsorted
  // findOne, so a stray same-user document would otherwise make the read flaky).
  const base = (userId: string) => ({
    userId,
    type: ApiKeyType.anthropic,
    isActive: true,
    expiresAt: new Date(Date.now() + 86_400_000),
  });

  it('encrypts the key at rest but echoes the submitted plaintext from create', async () => {
    const created = await apiKeyRepository.create({ ...base('user-encrypt'), apiKey: 'sk-ant-plainkey' });
    // The create response echoes the plaintext the caller submitted...
    expect(created.apiKey).toBe('sk-ant-plainkey');
    // ...but the stored document is ciphertext.
    const raw = await ApiKey.findOne({ userId: 'user-encrypt', type: ApiKeyType.anthropic }).lean();
    expect(isEncrypted(raw?.apiKey as string)).toBe(true);
    expect(raw?.apiKey).not.toBe('sk-ant-plainkey');
  });

  it('decrypts the key on the read paths consumers use', async () => {
    await apiKeyRepository.create({ ...base('user-read'), apiKey: 'sk-ant-readable' });

    const byType = await apiKeyRepository.findByUserIdAndType('user-read', ApiKeyType.anthropic);
    expect(byType?.apiKey).toBe('sk-ant-readable');

    const byTypes = await apiKeyRepository.findByUserIdAndTypes('user-read', [ApiKeyType.anthropic]);
    expect(byTypes[0]?.apiKey).toBe('sk-ant-readable');
  });
});
