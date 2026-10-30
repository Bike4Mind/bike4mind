import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encryptSecret, generateEncryptionKey } from './secretEncryption';

// Mock config before importing tokenEncryption
const mockConfig: Record<string, string | undefined> = {};
vi.mock('../utils/config', () => ({
  Config: new Proxy({}, { get: (_, key: string) => mockConfig[key] }),
}));

// Import after mock
const { encryptToken, decryptToken, encryptEnvVariables, decryptEnvVariables } = await import('./tokenEncryption');

const defaultMcpOwner = { id: 'mcp-record', name: 'test-server', userId: 'test-user' };

describe('tokenEncryption', () => {
  const key1 = generateEncryptionKey();
  const key2 = generateEncryptionKey();

  beforeEach(() => {
    mockConfig.SECRET_ENCRYPTION_KEY = key1;
    mockConfig.SECRET_ENCRYPTION_KEY_PREVIOUS = undefined;
  });

  describe('encryptToken', () => {
    it('should encrypt a plaintext value', () => {
      const encrypted = encryptToken('xoxb-my-token');
      expect(encrypted).not.toBe('xoxb-my-token');
      expect(encrypted!.split(':')).toHaveLength(3);
    });

    it('should return null for null/undefined', () => {
      expect(encryptToken(null)).toBeNull();
      expect(encryptToken(undefined)).toBeNull();
    });

    it('encrypts ciphertext-shaped input as literal plaintext', () => {
      const encrypted = encryptToken('xoxb-my-token')!;
      const doubleEncrypted = encryptToken(encrypted);
      expect(decryptToken(doubleEncrypted)).toBe(encrypted);
    });
  });

  describe('decryptToken', () => {
    it('should decrypt a value encrypted with current key', () => {
      const encrypted = encryptSecret('my-secret', key1);
      expect(decryptToken(encrypted)).toBe('my-secret');
    });

    it('should return null for null/undefined', () => {
      expect(decryptToken(null)).toBeNull();
      expect(decryptToken(undefined)).toBeNull();
    });

    it('should pass through plaintext values (backward compat)', () => {
      expect(decryptToken('xoxb-plaintext-token')).toBe('xoxb-plaintext-token');
    });

    it('should fall back to previous key during rotation', () => {
      // Encrypt with key1 (old key)
      const encrypted = encryptSecret('rotated-secret', key1);

      // Now key2 is current, key1 is previous
      mockConfig.SECRET_ENCRYPTION_KEY = key2;
      mockConfig.SECRET_ENCRYPTION_KEY_PREVIOUS = key1;

      expect(decryptToken(encrypted)).toBe('rotated-secret');
    });

    it('should throw when both keys fail', () => {
      const encrypted = encryptSecret('secret', key1);
      const key3 = generateEncryptionKey();

      mockConfig.SECRET_ENCRYPTION_KEY = key2;
      mockConfig.SECRET_ENCRYPTION_KEY_PREVIOUS = key3;

      expect(() => decryptToken(encrypted)).toThrow('Token decryption failed');
    });

    it('should throw when current key fails and no previous key configured', () => {
      const encrypted = encryptSecret('secret', key1);
      mockConfig.SECRET_ENCRYPTION_KEY = key2;

      expect(() => decryptToken(encrypted)).toThrow('Token decryption failed');
    });
  });

  describe('encryptEnvVariables', () => {
    it('should encrypt all env variable values', () => {
      const vars = [
        { key: 'API_KEY', value: 'secret-key' },
        { key: 'TOKEN', value: 'secret-token' },
      ];
      const encrypted = encryptEnvVariables(vars, defaultMcpOwner);
      expect(encrypted[0].key).toBe('API_KEY');
      expect(encrypted[0].value).not.toBe('secret-key');
      expect(encrypted[1].key).toBe('TOKEN');
      expect(encrypted[1].value).not.toBe('secret-token');
    });

    // A request cannot use ciphertext shape as proof of trusted storage provenance.
    it('encrypts submitted ciphertext-shaped env values literally', () => {
      const once = encryptEnvVariables([{ key: 'API_KEY', value: 'secret-key' }], defaultMcpOwner);

      expect(decryptEnvVariables(encryptEnvVariables(once, defaultMcpOwner), defaultMcpOwner)).toEqual(once);
    });
  });

  describe('decryptEnvVariables', () => {
    it('should decrypt env variables with key rotation fallback', () => {
      // Encrypt with key1
      const vars = [{ key: 'API_KEY', value: encryptSecret('secret-key', key1) }];

      // Rotate to key2
      mockConfig.SECRET_ENCRYPTION_KEY = key2;
      mockConfig.SECRET_ENCRYPTION_KEY_PREVIOUS = key1;

      const decrypted = decryptEnvVariables(vars, defaultMcpOwner);
      expect(decrypted[0].value).toBe('secret-key');
    });
  });
});

describe('MCP secret ownership', () => {
  it('rejects an env blob copied to another owner, server or field', () => {
    mockConfig.SECRET_ENCRYPTION_KEY = generateEncryptionKey();
    const owner = { id: 'server-a', userId: 'user-a', name: 'server-a' };
    const vars = encryptEnvVariables([{ key: 'API_KEY', value: 'provider-secret' }], owner);
    expect(decryptEnvVariables(vars, owner)[0].value).toBe('provider-secret');
    expect(() => decryptEnvVariables(vars, { ...owner, userId: 'user-b' })).toThrow();
    expect(() => decryptEnvVariables(vars, { ...owner, id: 'server-b' })).toThrow();
    expect(() => decryptEnvVariables([{ ...vars[0], key: 'OTHER_KEY' }], owner)).toThrow();
    expect(decryptEnvVariables(encryptEnvVariables(vars, owner), owner)).toEqual(vars);
  });
});
