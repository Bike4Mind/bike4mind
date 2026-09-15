import { describe, it, expect } from 'vitest';
import {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  generateEncryptionKey,
  isValidEncryptionKey,
} from './secretEncryption';

describe('secretEncryption', () => {
  // Generate a valid test key (64 hex chars = 32 bytes)
  const validKey = 'a'.repeat(64);

  describe('encryptSecret', () => {
    it('should encrypt a plaintext string', () => {
      const plaintext = 'my-secret-token';
      const encrypted = encryptSecret(plaintext, validKey);

      expect(encrypted).toBeDefined();
      expect(encrypted).not.toBe(plaintext);
      // Format: iv(32 hex):authTag(32 hex):data(hex)
      expect(encrypted.split(':')).toHaveLength(3);
    });

    it('should produce different ciphertexts for same plaintext (random IV)', () => {
      const plaintext = 'same-secret';
      const encrypted1 = encryptSecret(plaintext, validKey);
      const encrypted2 = encryptSecret(plaintext, validKey);

      // Different IVs should produce different outputs
      expect(encrypted1).not.toBe(encrypted2);
    });

    it('should throw on empty plaintext', () => {
      expect(() => encryptSecret('', validKey)).toThrow('Cannot encrypt empty plaintext');
    });

    it('should throw on invalid key length', () => {
      expect(() => encryptSecret('secret', 'short-key')).toThrow('Encryption key must be 64 hex characters (32 bytes)');
    });

    it('should throw on missing key', () => {
      expect(() => encryptSecret('secret', '')).toThrow('Encryption key must be 64 hex characters (32 bytes)');
    });
  });

  describe('decryptSecret', () => {
    it('should decrypt an encrypted string', () => {
      const plaintext = 'my-secret-token';
      const encrypted = encryptSecret(plaintext, validKey);
      const decrypted = decryptSecret(encrypted, validKey);

      expect(decrypted).toBe(plaintext);
    });

    it('should handle special characters', () => {
      const plaintext = 'secret!@#$%^&*()_+-=[]{}|;:,.<>?/~`"\'\\';
      const encrypted = encryptSecret(plaintext, validKey);
      const decrypted = decryptSecret(encrypted, validKey);

      expect(decrypted).toBe(plaintext);
    });

    it('should handle unicode characters', () => {
      const plaintext = '秘密のトークン 🔐';
      const encrypted = encryptSecret(plaintext, validKey);
      const decrypted = decryptSecret(encrypted, validKey);

      expect(decrypted).toBe(plaintext);
    });

    it('should handle long strings', () => {
      const plaintext = 'a'.repeat(10000);
      const encrypted = encryptSecret(plaintext, validKey);
      const decrypted = decryptSecret(encrypted, validKey);

      expect(decrypted).toBe(plaintext);
    });

    it('should throw on empty ciphertext', () => {
      expect(() => decryptSecret('', validKey)).toThrow('Cannot decrypt empty ciphertext');
    });

    it('should throw on invalid format', () => {
      expect(() => decryptSecret('invalid-format', validKey)).toThrow(
        'Invalid encrypted format. Expected iv:authTag:ciphertext'
      );
    });

    it('should throw on invalid IV length', () => {
      expect(() => decryptSecret('short:' + 'a'.repeat(32) + ':data', validKey)).toThrow('Invalid IV length');
    });

    it('should throw on invalid auth tag length', () => {
      expect(() => decryptSecret('a'.repeat(32) + ':short:data', validKey)).toThrow('Invalid auth tag length');
    });

    it('should throw on wrong key (authentication failure)', () => {
      const plaintext = 'secret';
      const encrypted = encryptSecret(plaintext, validKey);
      const wrongKey = 'b'.repeat(64);

      expect(() => decryptSecret(encrypted, wrongKey)).toThrow();
    });

    it('should throw on tampered ciphertext (authentication failure)', () => {
      const plaintext = 'secret';
      const encrypted = encryptSecret(plaintext, validKey);

      // Tamper with the encrypted data
      const parts = encrypted.split(':');
      parts[2] = 'f'.repeat(parts[2].length);
      const tampered = parts.join(':');

      expect(() => decryptSecret(tampered, validKey)).toThrow();
    });

    it('should throw on invalid key length', () => {
      expect(() => decryptSecret('a'.repeat(32) + ':' + 'a'.repeat(32) + ':data', 'short')).toThrow(
        'Encryption key must be 64 hex characters (32 bytes)'
      );
    });
  });

  describe('isEncrypted', () => {
    it('should return true for properly formatted encrypted strings', () => {
      const encrypted = encryptSecret('test', validKey);
      expect(isEncrypted(encrypted)).toBe(true);
    });

    it('should return true for valid encrypted format pattern', () => {
      const validFormat = 'a'.repeat(32) + ':' + 'b'.repeat(32) + ':' + 'c'.repeat(20);
      expect(isEncrypted(validFormat)).toBe(true);
    });

    it('should return false for empty string', () => {
      expect(isEncrypted('')).toBe(false);
    });

    it('should return false for non-encrypted strings', () => {
      expect(isEncrypted('just-a-plain-token')).toBe(false);
      expect(isEncrypted('token:with:colons')).toBe(false);
    });

    it('should return false for strings with wrong IV length', () => {
      expect(isEncrypted('short:' + 'a'.repeat(32) + ':data')).toBe(false);
    });

    it('should return false for strings with wrong auth tag length', () => {
      expect(isEncrypted('a'.repeat(32) + ':short:data')).toBe(false);
    });

    it('should return false for strings with non-hex characters', () => {
      expect(isEncrypted('g'.repeat(32) + ':' + 'a'.repeat(32) + ':data')).toBe(false);
    });
  });

  describe('generateEncryptionKey', () => {
    it('should generate a 64-character hex key', () => {
      const key = generateEncryptionKey();
      expect(key).toHaveLength(64);
      expect(/^[a-f0-9]+$/i.test(key)).toBe(true);
    });

    it('should generate unique keys', () => {
      const key1 = generateEncryptionKey();
      const key2 = generateEncryptionKey();
      expect(key1).not.toBe(key2);
    });

    it('should generate valid keys that work for encryption', () => {
      const key = generateEncryptionKey();
      const plaintext = 'test-secret';

      const encrypted = encryptSecret(plaintext, key);
      const decrypted = decryptSecret(encrypted, key);

      expect(decrypted).toBe(plaintext);
    });
  });

  describe('isValidEncryptionKey', () => {
    it('should return true for valid 64-char hex keys', () => {
      expect(isValidEncryptionKey('a'.repeat(64))).toBe(true);
      expect(isValidEncryptionKey('0123456789abcdef'.repeat(4))).toBe(true);
      expect(isValidEncryptionKey('ABCDEF0123456789'.repeat(4))).toBe(true);
    });

    it('should return false for empty key', () => {
      expect(isValidEncryptionKey('')).toBe(false);
    });

    it('should return false for too short keys', () => {
      expect(isValidEncryptionKey('a'.repeat(63))).toBe(false);
    });

    it('should return false for too long keys', () => {
      expect(isValidEncryptionKey('a'.repeat(65))).toBe(false);
    });

    it('should return false for non-hex characters', () => {
      expect(isValidEncryptionKey('g'.repeat(64))).toBe(false);
      expect(isValidEncryptionKey('z'.repeat(64))).toBe(false);
    });

    it('should validate generated keys', () => {
      const key = generateEncryptionKey();
      expect(isValidEncryptionKey(key)).toBe(true);
    });
  });

  describe('round-trip encryption/decryption', () => {
    it('should correctly round-trip various data types', () => {
      const testCases = [
        'simple-string',
        'string with spaces and punctuation!',
        '{"json": "data", "number": 123}',
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
        Buffer.from('binary data').toString('base64'),
      ];

      const key = generateEncryptionKey();

      for (const testCase of testCases) {
        const encrypted = encryptSecret(testCase, key);
        const decrypted = decryptSecret(encrypted, key);
        expect(decrypted).toBe(testCase);
      }
    });
  });
});
