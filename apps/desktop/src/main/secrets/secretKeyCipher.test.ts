import { describe, expect, it, vi } from 'vitest';
import { isSecretKeyBlob, SecretKeyCipher } from './secretKeyCipher';

const KEY = Buffer.alloc(32, 9);

describe('SecretKeyCipher', () => {
  it('round-trips text, with a fresh nonce on every call', () => {
    const cipher = new SecretKeyCipher(() => KEY);

    const first = cipher.encryptString('token-value');
    const second = cipher.encryptString('token-value');

    expect(cipher.decryptString(first)).toBe('token-value');
    expect(cipher.decryptString(second)).toBe('token-value');
    expect(first.equals(second)).toBe(false);
    expect(first.includes(Buffer.from('token-value'))).toBe(false);
  });

  it('lays a blob out as the ASCII marker, a 12-byte nonce, a 16-byte tag and the ciphertext', () => {
    const blob = new SecretKeyCipher(() => KEY).encryptString('abc');

    expect(blob.subarray(0, 7).toString('ascii')).toBe('b4m-sk1');
    expect(blob).toHaveLength(7 + 12 + 16 + 3);
    expect(isSecretKeyBlob(blob)).toBe(true);
  });

  it('reads the key once and keeps it for the rest of the process', () => {
    const loadKey = vi.fn(() => KEY);
    const cipher = new SecretKeyCipher(loadKey);

    expect(cipher.isEncryptionAvailable()).toBe(true);
    cipher.decryptString(cipher.encryptString('x'));
    expect(cipher.isEncryptionAvailable()).toBe(true);

    expect(loadKey).toHaveBeenCalledTimes(1);
  });

  it('is unavailable without a key, asks only once, and refuses to encrypt or decrypt', () => {
    const loadKey = vi.fn(() => null);
    const cipher = new SecretKeyCipher(loadKey);
    const sealed = new SecretKeyCipher(() => KEY).encryptString('x');

    expect(cipher.isEncryptionAvailable()).toBe(false);
    expect(cipher.isEncryptionAvailable()).toBe(false);
    expect(() => cipher.encryptString('x')).toThrow();
    expect(() => cipher.decryptString(sealed)).toThrow();
    expect(loadKey).toHaveBeenCalledTimes(1);
  });

  it('throws on a tampered ciphertext, tag or nonce', () => {
    const cipher = new SecretKeyCipher(() => KEY);
    const blob = cipher.encryptString('secret text');

    for (const offset of [7, 7 + 12, blob.length - 1]) {
      const tampered = Buffer.from(blob);
      tampered[offset] ^= 0x01;
      expect(() => cipher.decryptString(tampered)).toThrow();
    }
  });

  it('throws on a blob sealed with another key, or too short to hold a nonce and tag', () => {
    const blob = new SecretKeyCipher(() => Buffer.alloc(32, 1)).encryptString('x');
    const cipher = new SecretKeyCipher(() => KEY);

    expect(() => cipher.decryptString(blob)).toThrow();
    expect(() => cipher.decryptString(blob.subarray(0, 7 + 20))).toThrow();
  });
});

describe('isSecretKeyBlob', () => {
  it('tells the marker apart from safeStorage blobs', () => {
    expect(isSecretKeyBlob(Buffer.from('v10abcdef'))).toBe(false);
    expect(isSecretKeyBlob(Buffer.from('v11abcdef'))).toBe(false);
    expect(isSecretKeyBlob(Buffer.from('b4m'))).toBe(false);
    expect(isSecretKeyBlob(Buffer.alloc(0))).toBe(false);
  });
});
