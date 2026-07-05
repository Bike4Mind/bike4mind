import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateEncryptionKey,
  validateMongoUri,
  validateSessionSecret,
  validateJwtSecret,
  JWT_SECRET_MIN_LENGTH,
  JWT_SECRET_WARN_LENGTH,
  SESSION_SECRET_MIN_LENGTH,
} from './tier1SecretValidators';

// Mock SST_PLACEHOLDER_VALUE from @bike4mind/common
vi.mock('@bike4mind/common', () => ({
  SST_PLACEHOLDER_VALUE: 'my-secret-placeholder-value',
}));

// Mock isValidEncryptionKey from secretEncryption
vi.mock('./secretEncryption', () => ({
  isValidEncryptionKey: vi.fn((key: string) => key.length === 64 && /^[a-f0-9]+$/i.test(key)),
}));

describe('tier1SecretValidators', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validateJwtSecret', () => {
    it('returns missing for undefined', () => {
      const result = validateJwtSecret(undefined);
      expect(result.status).toBe('missing');
      expect(result.severity).toBe('error');
      expect(result.isValid).toBe(false);
    });

    it('returns placeholder for SST placeholder value', () => {
      const result = validateJwtSecret('my-secret-placeholder-value');
      expect(result.status).toBe('placeholder');
      expect(result.severity).toBe('error');
      expect(result.isValid).toBe(false);
    });

    it('returns placeholder for common placeholders', () => {
      expect(validateJwtSecret('changeme').status).toBe('placeholder');
      expect(validateJwtSecret('CHANGEME').status).toBe('placeholder');
      expect(validateJwtSecret('change_me').status).toBe('placeholder');
      expect(validateJwtSecret('your-secret-key').status).toBe('placeholder');
      expect(validateJwtSecret('replace-me').status).toBe('placeholder');
      expect(validateJwtSecret('xxx').status).toBe('placeholder');
      expect(validateJwtSecret('todo').status).toBe('placeholder');
      expect(validateJwtSecret('fixme').status).toBe('placeholder');
    });

    it('returns invalid for low-entropy secrets', () => {
      const result = validateJwtSecret('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(result.status).toBe('invalid');
      expect(result.severity).toBe('error');
      expect(result.message).toContain('low-entropy');
    });

    it('returns insecure for secrets under 32 chars', () => {
      const result = validateJwtSecret('short-secret-16ch');
      expect(result.status).toBe('insecure');
      expect(result.severity).toBe('error');
      expect(result.isValid).toBe(false);
      expect(result.message).toContain('17 characters');
    });

    // Boundary tests for 31/32/33 characters
    it('returns insecure for exactly 31 chars (boundary)', () => {
      const secret31chars = 'abc123XYZ!@#def456UVW$%^ghi78ab';
      expect(secret31chars.length).toBe(31);
      const result = validateJwtSecret(secret31chars);
      expect(result.status).toBe('insecure');
      expect(result.isValid).toBe(false);
    });

    it('returns warning for exactly 32 chars (boundary)', () => {
      const secret32chars = 'abc123XYZ!@#def456UVW$%^ghi789ab';
      expect(secret32chars.length).toBe(32);
      const result = validateJwtSecret(secret32chars);
      expect(result.status).toBe('warning');
      expect(result.isValid).toBe(true);
    });

    it('returns warning for exactly 33 chars (boundary)', () => {
      const secret33chars = 'abc123XYZ!@#def456UVW$%^ghi789abc';
      expect(secret33chars.length).toBe(33);
      const result = validateJwtSecret(secret33chars);
      expect(result.status).toBe('warning');
      expect(result.isValid).toBe(true);
    });

    it('returns warning for secrets between 32-64 chars', () => {
      // Use a realistic base64-style secret (not repeating single char to avoid low-entropy check)
      const secret40chars = 'abc123XYZ!@#def456UVW$%^ghi789RST&*(jklm';
      expect(secret40chars.length).toBe(40);
      const result = validateJwtSecret(secret40chars);
      expect(result.status).toBe('warning');
      expect(result.severity).toBe('warning');
      expect(result.isValid).toBe(true);
      expect(result.message).toContain('40 characters');
      expect(result.message).toContain('Recommend');
    });

    it('returns configured for secrets 64+ chars', () => {
      const secret64chars = 'a1b2c3d4'.repeat(8); // 64 chars with variety
      expect(secret64chars.length).toBe(64);
      const result = validateJwtSecret(secret64chars);
      expect(result.status).toBe('configured');
      expect(result.severity).toBe('info');
      expect(result.isValid).toBe(true);
    });

    it('returns configured for secrets longer than 64 chars', () => {
      // Use varied characters to avoid low-entropy detection
      const secret100chars = 'abc123XYZ'.repeat(12).slice(0, 100);
      expect(secret100chars.length).toBe(100);
      const result = validateJwtSecret(secret100chars);
      expect(result.status).toBe('configured');
      expect(result.isValid).toBe(true);
    });
  });

  describe('validateSessionSecret', () => {
    it('returns missing for undefined', () => {
      const result = validateSessionSecret(undefined);
      expect(result.status).toBe('missing');
      expect(result.severity).toBe('error');
    });

    it('returns placeholder for SST placeholder value', () => {
      const result = validateSessionSecret('my-secret-placeholder-value');
      expect(result.status).toBe('placeholder');
    });

    it('returns insecure for secrets under 32 chars', () => {
      const result = validateSessionSecret('short');
      expect(result.status).toBe('insecure');
      expect(result.severity).toBe('error');
      expect(result.message).toContain('5 characters');
    });

    // Boundary tests for 31/32/33 characters
    it('returns insecure for exactly 31 chars (boundary)', () => {
      const secret31chars = 'abc123XYZ!@#def456UVW$%^ghi78ab';
      expect(secret31chars.length).toBe(31);
      const result = validateSessionSecret(secret31chars);
      expect(result.status).toBe('insecure');
      expect(result.isValid).toBe(false);
    });

    it('returns configured for exactly 32 chars (boundary)', () => {
      const secret32chars = 'abc123XYZ!@#def456UVW$%^ghi789ab';
      expect(secret32chars.length).toBe(32);
      const result = validateSessionSecret(secret32chars);
      expect(result.status).toBe('configured');
      expect(result.isValid).toBe(true);
    });

    it('returns configured for exactly 33 chars (boundary)', () => {
      const secret33chars = 'abc123XYZ!@#def456UVW$%^ghi789abc';
      expect(secret33chars.length).toBe(33);
      const result = validateSessionSecret(secret33chars);
      expect(result.status).toBe('configured');
      expect(result.isValid).toBe(true);
    });

    it('returns invalid for low-entropy secrets', () => {
      const result = validateSessionSecret('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
      expect(result.status).toBe('invalid');
      expect(result.message).toContain('low-entropy');
    });

    it('returns configured for secrets 32+ chars', () => {
      // Use varied characters to avoid low-entropy detection
      const secret32chars = 'abc123XYZ!@#def456UVW$%^ghi789ab';
      expect(secret32chars.length).toBe(32);
      const result = validateSessionSecret(secret32chars);
      expect(result.status).toBe('configured');
      expect(result.severity).toBe('info');
    });
  });

  describe('validateEncryptionKey', () => {
    it('returns missing for undefined', () => {
      const result = validateEncryptionKey(undefined);
      expect(result.status).toBe('missing');
      expect(result.severity).toBe('error');
    });

    it('returns placeholder for SST placeholder value', () => {
      const result = validateEncryptionKey('my-secret-placeholder-value');
      expect(result.status).toBe('placeholder');
    });

    it('returns configured for valid 64 hex chars', () => {
      // Use varied hex characters to avoid low-entropy detection
      const validKey = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
      expect(validKey.length).toBe(64);
      const result = validateEncryptionKey(validKey);
      expect(result.status).toBe('configured');
      expect(result.severity).toBe('info');
    });

    it('returns invalid for non-hex chars', () => {
      const invalidKey = 'g'.repeat(64);
      const result = validateEncryptionKey(invalidKey);
      expect(result.status).toBe('invalid');
      expect(result.message).toContain('64 hexadecimal');
    });

    it('returns invalid for wrong length', () => {
      const shortKey = 'a'.repeat(32);
      const result = validateEncryptionKey(shortKey);
      expect(result.status).toBe('invalid');
    });

    it('returns invalid for low-entropy key', async () => {
      // Mock isValidEncryptionKey to return true for this test
      const { isValidEncryptionKey } = await import('./secretEncryption');
      vi.mocked(isValidEncryptionKey).mockReturnValueOnce(true);

      const lowEntropyKey = 'a'.repeat(64);
      const result = validateEncryptionKey(lowEntropyKey);
      expect(result.status).toBe('invalid');
      expect(result.message).toContain('low-entropy');
    });
  });

  describe('validateMongoUri', () => {
    it('returns missing for undefined', () => {
      const result = validateMongoUri(undefined);
      expect(result.status).toBe('missing');
      expect(result.severity).toBe('error');
    });

    it('returns placeholder for SST placeholder value', () => {
      const result = validateMongoUri('my-secret-placeholder-value');
      expect(result.status).toBe('placeholder');
    });

    it('returns configured for valid mongodb:// URI', () => {
      const result = validateMongoUri('mongodb://localhost:27017/test');
      expect(result.status).toBe('configured');
      expect(result.severity).toBe('info');
    });

    it('returns configured for valid mongodb+srv:// URI', () => {
      const result = validateMongoUri('mongodb+srv://cluster.example.com/test');
      expect(result.status).toBe('configured');
    });

    it('returns invalid for wrong scheme', () => {
      const result = validateMongoUri('postgres://localhost/test');
      expect(result.status).toBe('invalid');
      expect(result.message).toContain('mongodb://');
    });

    it('returns invalid for localhost in production', () => {
      const result = validateMongoUri('mongodb://localhost:27017/test', 'production');
      expect(result.status).toBe('invalid');
      expect(result.severity).toBe('error');
      expect(result.message).toContain('localhost');
    });

    it('returns invalid for localhost in prod stage', () => {
      const result = validateMongoUri('mongodb://localhost:27017/test', 'prod');
      expect(result.status).toBe('invalid');
      expect(result.message).toContain('localhost');
    });

    it('returns invalid for 127.0.0.1 in production', () => {
      const result = validateMongoUri('mongodb://127.0.0.1:27017/test', 'production');
      expect(result.status).toBe('invalid');
      expect(result.message).toContain('localhost');
    });

    it('allows localhost in dev stage', () => {
      const result = validateMongoUri('mongodb://localhost:27017/test', 'dev');
      expect(result.status).toBe('configured');
    });

    it('allows localhost in staging', () => {
      const result = validateMongoUri('mongodb://localhost:27017/test', 'staging');
      expect(result.status).toBe('configured');
    });

    it('allows localhost when stage is not specified', () => {
      const result = validateMongoUri('mongodb://localhost:27017/test');
      expect(result.status).toBe('configured');
    });
  });

  describe('exported constants', () => {
    it('has correct JWT_SECRET_MIN_LENGTH', () => {
      expect(JWT_SECRET_MIN_LENGTH).toBe(64);
    });

    it('has correct JWT_SECRET_WARN_LENGTH', () => {
      expect(JWT_SECRET_WARN_LENGTH).toBe(32);
    });

    it('has correct SESSION_SECRET_MIN_LENGTH', () => {
      expect(SESSION_SECRET_MIN_LENGTH).toBe(32);
    });
  });
});
