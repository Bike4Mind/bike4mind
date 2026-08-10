import { describe, it, expect, beforeEach } from 'vitest';
import { encryptSecret, generateEncryptionKey, isEncrypted } from './secretEncryption';
import { configureSecretsAtRest, decryptAtRest, encryptAtRest, isSecretsAtRestConfigured } from './secretsAtRest';

const KEY = generateEncryptionKey();
const PREVIOUS_KEY = generateEncryptionKey();

describe('secretsAtRest', () => {
  beforeEach(() => {
    configureSecretsAtRest(KEY);
  });

  it('round-trips a secret through encryptAtRest/decryptAtRest', () => {
    const cipher = encryptAtRest('sk-ant-api03-secret');
    expect(cipher).not.toBe('sk-ant-api03-secret');
    expect(isEncrypted(cipher)).toBe(true);
    expect(decryptAtRest(cipher)).toBe('sk-ant-api03-secret');
  });

  it('reports configuration state from the registered key', () => {
    expect(isSecretsAtRestConfigured()).toBe(true);
    configureSecretsAtRest(undefined);
    expect(isSecretsAtRestConfigured()).toBe(false);
  });

  it('passes a plaintext (not-yet-migrated) value through decryptAtRest unchanged', () => {
    expect(decryptAtRest('sk-plaintext-not-migrated')).toBe('sk-plaintext-not-migrated');
  });

  it('is idempotent: encryptAtRest leaves already-encrypted input untouched', () => {
    const cipher = encryptAtRest('secret');
    expect(encryptAtRest(cipher)).toBe(cipher);
  });

  it('rejects a malformed key by treating storage as unconfigured (plaintext passthrough)', () => {
    configureSecretsAtRest('too-short');
    expect(isSecretsAtRestConfigured()).toBe(false);
    // No key -> encryptAtRest cannot encrypt, so it must not throw or corrupt; it passes through.
    expect(encryptAtRest('secret')).toBe('secret');
  });

  it('decrypts a value encrypted under the previous key after rotation', () => {
    const legacyCipher = encryptSecret('rotated-secret', PREVIOUS_KEY);
    configureSecretsAtRest(KEY, PREVIOUS_KEY);
    expect(decryptAtRest(legacyCipher)).toBe('rotated-secret');
  });

  it('returns ciphertext unchanged (never a plaintext guess) when no key can decrypt it', () => {
    const cipher = encryptSecret('secret', generateEncryptionKey());
    configureSecretsAtRest(KEY); // neither current nor previous can decrypt this
    expect(decryptAtRest(cipher)).toBe(cipher);
  });

  it('leaves an empty string alone', () => {
    expect(encryptAtRest('')).toBe('');
    expect(decryptAtRest('')).toBe('');
  });
});
