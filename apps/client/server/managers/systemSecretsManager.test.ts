import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  clearSecretCache,
  getSecret,
  resolveSecret,
  getSecretsBatch,
  TIER1_SECRETS,
  RESOLVABLE_SECRETS,
} from './systemSecretsManager';

vi.mock('@bike4mind/database', () => ({
  systemSecretRepository: {
    findBySecretName: vi.fn(),
    findAll: vi.fn(),
  },
  SystemSecretCategory: {},
}));

vi.mock('sst', () => ({
  Resource: {},
}));

vi.mock('../utils/config', () => ({
  Config: {
    SECRET_ENCRYPTION_KEY: 'a'.repeat(64), // Valid 64 hex char key
  },
}));

vi.mock('../security/secretEncryption', () => ({
  decryptSecret: vi.fn((encrypted: string) => `decrypted_${encrypted}`),
  isValidEncryptionKey: vi.fn((key: string) => key.length === 64 && /^[a-f0-9]+$/i.test(key)),
}));

// Import mocks for manipulation
import { systemSecretRepository } from '@bike4mind/database';
import { Resource } from 'sst';
import { decryptSecret, isValidEncryptionKey } from '../security/secretEncryption';

describe('systemSecretsManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSecretCache();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('TIER1_SECRETS', () => {
    it('should contain the expected Tier 1 secrets', () => {
      expect(TIER1_SECRETS.has('SECRET_ENCRYPTION_KEY')).toBe(true);
      expect(TIER1_SECRETS.has('MONGODB_URI')).toBe(true);
      expect(TIER1_SECRETS.has('SESSION_SECRET')).toBe(true);
      expect(TIER1_SECRETS.has('JWT_SECRET')).toBe(true);
    });

    it('should have exactly 4 Tier 1 secrets', () => {
      expect(TIER1_SECRETS.size).toBe(4);
    });
  });

  describe('RESOLVABLE_SECRETS', () => {
    it('should not contain any Tier 1 secrets', () => {
      const resolvableNames = Object.keys(RESOLVABLE_SECRETS);
      for (const tier1Secret of TIER1_SECRETS) {
        expect(resolvableNames).not.toContain(tier1Secret);
      }
    });

    it('should have valid categories for all secrets', () => {
      const validCategories = ['auth', 'mail', 'oauth', 'api_key', 'slack'];
      for (const [_name, config] of Object.entries(RESOLVABLE_SECRETS)) {
        expect(validCategories).toContain(config.category);
        expect(config.description).toBeDefined();
        expect(typeof config.description).toBe('string');
      }
    });
  });

  describe('clearSecretCache', () => {
    it('should clear a specific secret from cache', async () => {
      vi.mocked(systemSecretRepository.findBySecretName).mockResolvedValue({
        secretName: 'MAIL_HOST',
        encryptedValue: 'encrypted_value',
        category: 'mail',
      } as never);

      await resolveSecret('MAIL_HOST');

      vi.mocked(systemSecretRepository.findBySecretName).mockClear();
      await resolveSecret('MAIL_HOST');
      expect(systemSecretRepository.findBySecretName).not.toHaveBeenCalled();

      clearSecretCache('MAIL_HOST');

      await resolveSecret('MAIL_HOST');
      expect(systemSecretRepository.findBySecretName).toHaveBeenCalledWith('MAIL_HOST');
    });

    it('should clear all cached secrets when called without argument', async () => {
      vi.mocked(systemSecretRepository.findBySecretName).mockResolvedValue({
        secretName: 'MAIL_HOST',
        encryptedValue: 'encrypted_value',
        category: 'mail',
      } as never);

      await resolveSecret('MAIL_HOST');
      await resolveSecret('MAIL_PORT');

      clearSecretCache();

      vi.mocked(systemSecretRepository.findBySecretName).mockClear();
      await resolveSecret('MAIL_HOST');
      expect(systemSecretRepository.findBySecretName).toHaveBeenCalled();
    });
  });

  describe('resolveSecret', () => {
    it('should throw for Tier 1 secrets', async () => {
      for (const tier1Secret of TIER1_SECRETS) {
        await expect(resolveSecret(tier1Secret)).rejects.toThrow(
          `${tier1Secret} is a Tier 1 secret and must be read directly from Config`
        );
      }
    });

    it('should return database value when found', async () => {
      vi.mocked(systemSecretRepository.findBySecretName).mockResolvedValue({
        secretName: 'MAIL_HOST',
        encryptedValue: 'encrypted_smtp_host',
        category: 'mail',
      } as never);

      const result = await resolveSecret('MAIL_HOST');

      expect(result.source).toBe('database');
      expect(result.value).toBe('decrypted_encrypted_smtp_host');
      expect(systemSecretRepository.findBySecretName).toHaveBeenCalledWith('MAIL_HOST');
    });

    it('should fall back to SST when database returns null', async () => {
      vi.mocked(systemSecretRepository.findBySecretName).mockResolvedValue(null);

      (Resource as unknown as Record<string, { value?: string }>)['MAIL_HOST'] = {
        value: 'sst_smtp_host',
      };

      const result = await resolveSecret('MAIL_HOST');

      expect(result.source).toBe('sst');
      expect(result.value).toBe('sst_smtp_host');
    });

    it('should return null source when not found anywhere', async () => {
      vi.mocked(systemSecretRepository.findBySecretName).mockResolvedValue(null);

      delete (Resource as unknown as Record<string, { value?: string }>)['UNKNOWN_SECRET'];

      const result = await resolveSecret('UNKNOWN_SECRET');

      expect(result.source).toBe(null);
      expect(result.value).toBeUndefined();
    });

    it('should ignore SST placeholder value', async () => {
      vi.mocked(systemSecretRepository.findBySecretName).mockResolvedValue(null);

      (Resource as unknown as Record<string, { value?: string }>)['MAIL_HOST'] = {
        value: 'my-secret-placeholder-value',
      };

      const result = await resolveSecret('MAIL_HOST');

      expect(result.source).toBe(null);
      expect(result.value).toBeUndefined();
    });

    it('should use cache on second call', async () => {
      vi.mocked(systemSecretRepository.findBySecretName).mockResolvedValue({
        secretName: 'MAIL_HOST',
        encryptedValue: 'encrypted_value',
        category: 'mail',
      } as never);

      await resolveSecret('MAIL_HOST');
      expect(systemSecretRepository.findBySecretName).toHaveBeenCalledTimes(1);

      await resolveSecret('MAIL_HOST');
      expect(systemSecretRepository.findBySecretName).toHaveBeenCalledTimes(1);
    });

    it('should skip cache when skipCache is true', async () => {
      vi.mocked(systemSecretRepository.findBySecretName).mockResolvedValue({
        secretName: 'MAIL_HOST',
        encryptedValue: 'encrypted_value',
        category: 'mail',
      } as never);

      await resolveSecret('MAIL_HOST');
      expect(systemSecretRepository.findBySecretName).toHaveBeenCalledTimes(1);

      await resolveSecret('MAIL_HOST', true);
      expect(systemSecretRepository.findBySecretName).toHaveBeenCalledTimes(2);
    });

    it('should include warnings when decryption fails', async () => {
      vi.mocked(systemSecretRepository.findBySecretName).mockResolvedValue({
        secretName: 'MAIL_HOST',
        encryptedValue: 'bad_encrypted_value',
        category: 'mail',
      } as never);

      vi.mocked(decryptSecret).mockImplementation(() => {
        throw new Error('Decryption failed');
      });

      const result = await resolveSecret('MAIL_HOST');

      expect(result.warnings).toBeDefined();
      expect(result.warnings?.some(w => w.includes('Failed to decrypt'))).toBe(true);
    });

    it('should include warnings when encryption key is invalid', async () => {
      vi.mocked(systemSecretRepository.findBySecretName).mockResolvedValue({
        secretName: 'MAIL_HOST',
        encryptedValue: 'encrypted_value',
        category: 'mail',
      } as never);

      vi.mocked(isValidEncryptionKey).mockReturnValue(false);

      const result = await resolveSecret('MAIL_HOST');

      expect(result.warnings).toBeDefined();
      expect(result.warnings?.some(w => w.includes('SECRET_ENCRYPTION_KEY is invalid'))).toBe(true);
    });
  });

  describe('getSecret', () => {
    it('should return just the value from resolveSecret', async () => {
      vi.mocked(systemSecretRepository.findBySecretName).mockResolvedValue({
        secretName: 'MAIL_HOST',
        encryptedValue: 'encrypted_smtp_host',
        category: 'mail',
      } as never);

      const value = await getSecret('MAIL_HOST');

      expect(value).toBe('decrypted_encrypted_smtp_host');
    });

    it('should return undefined when secret not found', async () => {
      vi.mocked(systemSecretRepository.findBySecretName).mockResolvedValue(null);

      const value = await getSecret('NONEXISTENT');

      expect(value).toBeUndefined();
    });

    it('should throw for Tier 1 secrets', async () => {
      await expect(getSecret('SECRET_ENCRYPTION_KEY')).rejects.toThrow();
    });
  });

  describe('getSecretsBatch', () => {
    it('should resolve multiple secrets at once', async () => {
      vi.mocked(systemSecretRepository.findBySecretName).mockImplementation((name: string) =>
        Promise.resolve({
          secretName: name,
          encryptedValue: `encrypted_${name}`,
          category: 'mail',
        } as never)
      );

      const results = await getSecretsBatch(['MAIL_HOST', 'MAIL_PORT']);

      expect(results.get('MAIL_HOST')).toBe('decrypted_encrypted_MAIL_HOST');
      expect(results.get('MAIL_PORT')).toBe('decrypted_encrypted_MAIL_PORT');
    });

    it('should filter out Tier 1 secrets', async () => {
      vi.mocked(systemSecretRepository.findBySecretName).mockResolvedValue({
        secretName: 'MAIL_HOST',
        encryptedValue: 'encrypted_value',
        category: 'mail',
      } as never);

      const results = await getSecretsBatch(['MAIL_HOST', 'SECRET_ENCRYPTION_KEY', 'JWT_SECRET']);

      expect(results.has('MAIL_HOST')).toBe(true);
      expect(results.has('SECRET_ENCRYPTION_KEY')).toBe(false);
      expect(results.has('JWT_SECRET')).toBe(false);
    });

    it('should return empty map for empty input', async () => {
      const results = await getSecretsBatch([]);

      expect(results.size).toBe(0);
    });
  });
});
