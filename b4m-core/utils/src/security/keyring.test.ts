import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateEncryptionKey, encryptSecret } from './secretEncryption';
import {
  KeyringNotLoadedError,
  PROVIDER_RETRY_COOLDOWN_MS,
  ensureKeyring,
  getAtRestKeys,
  getStageDataKey,
  isKeyringLoaded,
  loadStaticKeyring,
  resetKeyringForTests,
} from './keyring';
import { createAwsKmsKeyProvider } from './keyProviders/awsKms';
import { createStaticKeyProvider } from './keyProviders/static';
import { decryptAtRest, encryptAtRest, isSecretsAtRestConfigured } from './secretsAtRest';

const LEGACY = generateEncryptionKey();
const DATA_KEY = Buffer.from(generateEncryptionKey(), 'hex');
const wrappedKey = Buffer.from('wrapped').toString('base64');

afterEach(() => {
  resetKeyringForTests();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('keyring before load', () => {
  it('throws from every accessor and helper, even if a key exists elsewhere', () => {
    vi.stubEnv('SECRET_ENCRYPTION_KEY', LEGACY);
    expect(isKeyringLoaded()).toBe(false);
    expect(() => getAtRestKeys()).toThrow(KeyringNotLoadedError);
    expect(() => getStageDataKey()).toThrow(KeyringNotLoadedError);
    expect(() => encryptAtRest('x')).toThrow(KeyringNotLoadedError);
    expect(() => decryptAtRest(encryptSecret('x', LEGACY))).toThrow(KeyringNotLoadedError);
    expect(() => isSecretsAtRestConfigured()).toThrow(KeyringNotLoadedError);
  });
});

describe('aws-kms provider', () => {
  it('unwraps the data key once, with the purpose/stage encryption context', async () => {
    const decrypt = vi.fn().mockResolvedValue(new Uint8Array(DATA_KEY));
    await ensureKeyring({
      provider: createAwsKmsKeyProvider({ wrappedKey, stage: 'prod', decrypt }),
      legacyKey: LEGACY,
    });
    expect(getStageDataKey()?.key).toBe(DATA_KEY.toString('hex'));
    expect(getAtRestKeys().current).toBe(LEGACY);
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(decrypt).toHaveBeenCalledWith({
      ciphertext: Buffer.from('wrapped'),
      encryptionContext: { purpose: 'secrets-at-rest', stage: 'prod' },
      signal: expect.any(AbortSignal),
    });

    await ensureKeyring({ provider: createStaticKeyProvider(LEGACY), legacyKey: LEGACY });
    expect(decrypt).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed unwrap: legacy keys work now, a call after the cooldown retries', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const decrypt = vi
      .fn()
      .mockRejectedValueOnce(new Error('kms down'))
      .mockResolvedValueOnce(new Uint8Array(DATA_KEY));
    const opts = { provider: createAwsKmsKeyProvider({ wrappedKey, stage: 'prod', decrypt }), legacyKey: LEGACY };

    await expect(ensureKeyring(opts)).rejects.toThrow('kms down');
    expect(getStageDataKey()).toBeNull();
    expect(decryptAtRest(encryptAtRest('s'))).toBe('s');

    // Inside the cooldown: no provider call, no rejection.
    await expect(ensureKeyring(opts)).resolves.toBeUndefined();
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(getStageDataKey()).toBeNull();

    vi.setSystemTime(Date.now() + PROVIDER_RETRY_COOLDOWN_MS + 1);
    await ensureKeyring(opts);
    expect(decrypt).toHaveBeenCalledTimes(2);
    expect(getStageDataKey()?.key).toBe(DATA_KEY.toString('hex'));
  });

  it('shares one unwrap between concurrent callers', async () => {
    const decrypt = vi.fn().mockResolvedValue(new Uint8Array(DATA_KEY));
    const opts = { provider: createAwsKmsKeyProvider({ wrappedKey, stage: 'prod', decrypt }), legacyKey: LEGACY };
    await Promise.all([ensureKeyring(opts), ensureKeyring(opts)]);
    expect(decrypt).toHaveBeenCalledTimes(1);
  });

  it('rejects within the timeout when the client never answers', async () => {
    const provider = createAwsKmsKeyProvider({
      wrappedKey,
      stage: 'prod',
      timeoutMs: 20,
      decrypt: () => new Promise(() => {}),
    });
    await expect(provider.load()).rejects.toThrow('timed out');
  });

  it('rejects a plaintext of the wrong length', async () => {
    const provider = createAwsKmsKeyProvider({ wrappedKey, stage: 's', decrypt: async () => new Uint8Array(5) });
    await expect(provider.load()).rejects.toThrow('wrong length');
  });
});

describe('static load during a provider load', () => {
  it('is not overwritten by the provider load that was already in flight', async () => {
    let resolve!: (key: { id: string; key: string }) => void;
    const slow = { name: 'aws-kms' as const, load: () => new Promise<{ id: string; key: string }>(r => (resolve = r)) };
    const pending = ensureKeyring({ provider: slow, legacyKey: LEGACY });
    loadStaticKeyring(LEGACY);
    resolve({ id: 'late', key: 'b'.repeat(64) });
    await pending;
    expect(getStageDataKey()).toEqual({ id: 'static', key: LEGACY });
  });
});

describe('static provider', () => {
  it('loads as "no key" for an absent or malformed key, and as the key otherwise', async () => {
    await ensureKeyring({ provider: createStaticKeyProvider('bad'), legacyKey: 'bad' });
    expect(isKeyringLoaded()).toBe(true);
    expect(getStageDataKey()).toBeNull();
    expect(isSecretsAtRestConfigured()).toBe(false);

    resetKeyringForTests();
    await ensureKeyring({ provider: createStaticKeyProvider(LEGACY), legacyKey: LEGACY });
    expect(getStageDataKey()).toEqual({ id: 'static', key: LEGACY });
    expect(decryptAtRest(encryptAtRest('s'))).toBe('s');
  });
});
