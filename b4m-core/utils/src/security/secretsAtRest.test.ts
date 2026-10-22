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

  it('encrypts ciphertext-shaped input as a literal secret', () => {
    const cipher = encryptAtRest('secret');
    expect(decryptAtRest(encryptAtRest(cipher))).toBe(cipher);
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

  it('returns "" (not the ciphertext) when no key can decrypt it, so downstream guards fire', () => {
    const cipher = encryptSecret('secret', generateEncryptionKey());
    configureSecretsAtRest(KEY); // neither current nor previous can decrypt this
    expect(decryptAtRest(cipher)).toBe('');
  });

  it('returns "" for a ciphertext value when no key is configured at all', () => {
    const cipher = encryptSecret('secret', KEY);
    configureSecretsAtRest(undefined);
    expect(decryptAtRest(cipher)).toBe('');
  });

  it('leaves an empty string alone', () => {
    expect(encryptAtRest('')).toBe('');
    expect(decryptAtRest('')).toBe('');
  });
});

describe('record-bound ciphertext', () => {
  it('requires the same owner, record and field to decrypt, including after key rotation', () => {
    configureSecretsAtRest(KEY);
    const owner = JSON.stringify(['ApiKey', 'user-a', 'record-a', 'apiKey']);
    const cipher = encryptAtRest('provider-secret', owner);
    expect(cipher.startsWith('v2:')).toBe(true);
    expect(decryptAtRest(cipher, owner)).toBe('provider-secret');
    expect(decryptAtRest(cipher, JSON.stringify(['ApiKey', 'user-b', 'record-a', 'apiKey']))).toBe('');
    expect(decryptAtRest(cipher, JSON.stringify(['ApiKey', 'user-a', 'record-b', 'apiKey']))).toBe('');
    expect(decryptAtRest(cipher)).toBe('');
    configureSecretsAtRest(PREVIOUS_KEY, KEY);
    expect(decryptAtRest(cipher, owner)).toBe('provider-secret');
  });
});

it('rejects ciphertext-shaped input when encryption is unconfigured', () => {
  const foreign = encryptSecret('foreign-secret', KEY);
  configureSecretsAtRest(undefined);
  expect(() => encryptAtRest(foreign)).toThrow('without an encryption key');
});
