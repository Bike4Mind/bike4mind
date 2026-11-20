import { describe, expect, it } from 'vitest';
import {
  ciphertextVersionPrefix,
  decryptSecret,
  encryptSecret,
  generateEncryptionKey,
  isEncrypted,
  rotateSecret,
} from './secretEncryption';

const currentKey = generateEncryptionKey();
const previousKey = generateEncryptionKey();
const otherKey = generateEncryptionKey();
const plaintext = 'provider-key-fixture';
const context = JSON.stringify(['ApiKey', 'owner-fixture', 'record-fixture', 'apiKey']);

const rotatedValue = (outcome: ReturnType<typeof rotateSecret>): string => {
  if (outcome.state !== 'rotated') throw new Error(`expected rotated, got ${outcome.state}`);
  return outcome.value;
};

describe('rotateSecret', () => {
  it('reports a value already under the current key as current', () => {
    const stored = encryptSecret(plaintext, currentKey);
    expect(rotateSecret(stored, currentKey, previousKey)).toEqual({ state: 'current' });
  });

  it('reports a current value as current when no previous key is supplied', () => {
    const stored = encryptSecret(plaintext, currentKey);
    expect(rotateSecret(stored, currentKey)).toEqual({ state: 'current' });
  });

  it('re-encrypts a previous-key value under the current key with the same plaintext', () => {
    const stored = encryptSecret(plaintext, previousKey);
    const value = rotatedValue(rotateSecret(stored, currentKey, previousKey));

    expect(value).not.toBe(stored);
    expect(isEncrypted(value)).toBe(true);
    expect(decryptSecret(value, currentKey)).toBe(plaintext);
    expect(() => decryptSecret(value, previousKey)).toThrow();
  });

  it('treats a rotated value as current on the next pass', () => {
    const value = rotatedValue(rotateSecret(encryptSecret(plaintext, previousKey), currentKey, previousKey));
    expect(rotateSecret(value, currentKey, previousKey)).toEqual({ state: 'current' });
  });

  it('reports a value under neither key as unreadable', () => {
    const stored = encryptSecret(plaintext, otherKey);
    expect(rotateSecret(stored, currentKey, previousKey)).toEqual({ state: 'unreadable' });
  });

  it('reports a previous-key value as unreadable when no previous key is supplied', () => {
    const stored = encryptSecret(plaintext, previousKey);
    expect(rotateSecret(stored, currentKey)).toEqual({ state: 'unreadable' });
    expect(rotateSecret(stored, currentKey, undefined, undefined)).toEqual({ state: 'unreadable' });
  });

  describe('context-bound values', () => {
    it('is current under the current key and the same context', () => {
      const stored = encryptSecret(plaintext, currentKey, context);
      expect(rotateSecret(stored, currentKey, previousKey, context)).toEqual({ state: 'current' });
    });

    it('rotates with the same context, keeps the bound prefix and still needs the context', () => {
      const stored = encryptSecret(plaintext, previousKey, context);
      expect(stored.startsWith(ciphertextVersionPrefix)).toBe(true);

      const value = rotatedValue(rotateSecret(stored, currentKey, previousKey, context));

      expect(value.startsWith(ciphertextVersionPrefix)).toBe(true);
      expect(decryptSecret(value, currentKey, context)).toBe(plaintext);
      expect(() => decryptSecret(value, currentKey)).toThrow();
      expect(() =>
        decryptSecret(value, currentKey, JSON.stringify(['ApiKey', 'someone-else', 'record', 'apiKey']))
      ).toThrow();
      expect(() => decryptSecret(value, previousKey, context)).toThrow();
    });

    it('reports a bound value as unreadable without its context', () => {
      const stored = encryptSecret(plaintext, previousKey, context);
      expect(rotateSecret(stored, currentKey, previousKey)).toEqual({ state: 'unreadable' });
    });

    it('reports a bound value as unreadable under a different context', () => {
      const stored = encryptSecret(plaintext, previousKey, context);
      const other = JSON.stringify(['ApiKey', 'someone-else', 'record-fixture', 'apiKey']);
      expect(rotateSecret(stored, currentKey, previousKey, other)).toEqual({ state: 'unreadable' });
    });

    it('does not treat a bound value under the current key as current for a different context', () => {
      const stored = encryptSecret(plaintext, currentKey, context);
      const other = JSON.stringify(['ApiKey', 'someone-else', 'record-fixture', 'apiKey']);
      expect(rotateSecret(stored, currentKey, previousKey, other)).toEqual({ state: 'unreadable' });
    });
  });

  describe('unbound values', () => {
    it('stay unbound after rotation', () => {
      const stored = encryptSecret(plaintext, previousKey);
      expect(stored.startsWith(ciphertextVersionPrefix)).toBe(false);

      const value = rotatedValue(rotateSecret(stored, currentKey, previousKey));

      expect(value.startsWith(ciphertextVersionPrefix)).toBe(false);
      expect(decryptSecret(value, currentKey)).toBe(plaintext);
    });

    it('stay unbound when a context is supplied anyway', () => {
      const value = rotatedValue(rotateSecret(encryptSecret(plaintext, previousKey), currentKey, previousKey, context));

      expect(value.startsWith(ciphertextVersionPrefix)).toBe(false);
      expect(decryptSecret(value, currentKey)).toBe(plaintext);
      expect(rotateSecret(encryptSecret(plaintext, currentKey), currentKey, previousKey, context)).toEqual({
        state: 'current',
      });
    });
  });

  describe('malformed input', () => {
    const malformed = [
      '',
      'plain-text-fixture',
      'a:b:c',
      `${'a'.repeat(32)}:${'b'.repeat(32)}`,
      `${'a'.repeat(31)}:${'b'.repeat(32)}:abcd`,
      `${'a'.repeat(32)}:${'b'.repeat(32)}:not-hex`,
      `${ciphertextVersionPrefix}${'a'.repeat(32)}:${'b'.repeat(32)}:abcd`,
      ciphertextVersionPrefix,
    ];

    it.each(malformed)('returns unreadable and never throws for %j', value => {
      expect(rotateSecret(value, currentKey, previousKey)).toEqual({ state: 'unreadable' });
      expect(rotateSecret(value, currentKey, previousKey, context)).toEqual({ state: 'unreadable' });
      expect(rotateSecret(value, currentKey)).toEqual({ state: 'unreadable' });
    });

    it('returns unreadable for a tampered ciphertext', () => {
      const stored = encryptSecret(plaintext, previousKey);
      const [iv, tag, data] = stored.split(':');
      const flipped = `${data.startsWith('0') ? '1' : '0'}${data.slice(1)}`;
      expect(rotateSecret(`${iv}:${tag}:${flipped}`, currentKey, previousKey)).toEqual({ state: 'unreadable' });
    });

    it('returns unreadable for a malformed key instead of throwing', () => {
      const stored = encryptSecret(plaintext, previousKey);
      expect(rotateSecret(stored, 'not-a-key', previousKey)).toEqual({ state: 'unreadable' });
      expect(rotateSecret(stored, currentKey, 'not-a-key')).toEqual({ state: 'unreadable' });
    });
  });
});
