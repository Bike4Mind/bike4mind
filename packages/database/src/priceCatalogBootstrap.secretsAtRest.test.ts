import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  decryptAtRest,
  encryptSecret,
  generateEncryptionKey,
  getStageDataKey,
  resetKeyringForTests,
} from '@bike4mind/utils/security';

const KEY = generateEncryptionKey();
const DATA_KEY = Buffer.from(generateEncryptionKey(), 'hex');

const resource = vi.hoisted(() => ({
  values: {} as Record<string, string | undefined>,
}));
const kms = vi.hoisted(() => ({ decrypt: vi.fn() }));

// Stand in for the SST runtime so this test proves the connectDB seam can source the key
// from Resource - the path a scripts/cron process (which never imports apps/client Config) takes.
vi.mock('sst', () => ({
  Resource: new Proxy(
    { App: { stage: 'test' } },
    {
      get: (target, name: string) =>
        name in target ? target[name as 'App'] : { value: resource.values[name] },
    }
  ),
}));
// Route the aws-kms provider's unwrap to a fake instead of a real KMS client.
vi.mock('@bike4mind/utils/security', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils/security')>();
  return {
    ...actual,
    createAwsKmsKeyProvider: (opts: Parameters<typeof actual.createAwsKmsKeyProvider>[0]) =>
      actual.createAwsKmsKeyProvider({ ...opts, decrypt: kms.decrypt }),
  };
});

describe('loadKeyringFromResource', () => {
  beforeEach(() => {
    resetKeyringForTests();
    kms.decrypt.mockReset();
    resource.values = { SECRET_ENCRYPTION_KEY: KEY };
  });

  it('self-host: no wrapped blob selects the static provider and decrypts v1/v2 values', async () => {
    const { loadKeyringFromResource, selectKeyProvider } = await import('./security/loadKeyringFromResource');
    expect(selectKeyProvider(KEY, () => undefined).name).toBe('static');
    await loadKeyringFromResource();
    expect(getStageDataKey()?.id).toBe('static');
    expect(decryptAtRest(encryptSecret('sk-secret-from-a-script', KEY))).toBe('sk-secret-from-a-script');
    expect(kms.decrypt).not.toHaveBeenCalled();
  });

  it('a wrapped blob selects aws-kms; a failed unwrap is retried by the next load', async () => {
    resource.values.SECRET_DATA_KEY_WRAPPED = Buffer.from('blob').toString('base64');
    const { loadKeyringFromResource } = await import('./security/loadKeyringFromResource');
    kms.decrypt.mockRejectedValueOnce(new Error('kms down')).mockResolvedValueOnce(new Uint8Array(DATA_KEY));

    await expect(loadKeyringFromResource()).rejects.toThrow('kms down');
    // Legacy keys still serve v1/v2 while the unwrap is down.
    expect(decryptAtRest(encryptSecret('still-readable', KEY))).toBe('still-readable');
    expect(getStageDataKey()).toBeNull();

    await loadKeyringFromResource();
    expect(getStageDataKey()?.key).toBe(DATA_KEY.toString('hex'));
    expect(kms.decrypt).toHaveBeenCalledTimes(2);
  });
});
