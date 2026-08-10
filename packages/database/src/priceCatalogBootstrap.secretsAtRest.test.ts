import { describe, it, expect, beforeEach, vi } from 'vitest';
import { configureSecretsAtRest, decryptAtRest, encryptSecret, generateEncryptionKey } from '@bike4mind/utils';

const KEY = generateEncryptionKey();

// Stand in for the SST runtime so this test proves the connectDB seam can source the key
// from Resource - the path a scripts/cron process (which never imports apps/client Config) takes.
vi.mock('sst', () => ({
  Resource: {
    SECRET_ENCRYPTION_KEY: { value: KEY },
    SECRET_ENCRYPTION_KEY_PREVIOUS: { value: undefined },
    App: { stage: 'test' },
  },
}));

describe('connectDB seam registers the at-rest key from SST resources', () => {
  beforeEach(() => {
    // Simulate a fresh process that has NOT imported @server/utils/config: no key registered.
    configureSecretsAtRest(undefined);
  });

  it('lets a config-less process decrypt a stored sensitive value after the seam runs', async () => {
    const cipher = encryptSecret('sk-secret-from-a-script', KEY);

    // Before the seam runs this is the P1 gap: unconfigured -> ciphertext returned as-is.
    expect(decryptAtRest(cipher)).toBe(cipher);

    const { configureSecretsAtRestFromResource } = await import('./priceCatalogBootstrap');
    configureSecretsAtRestFromResource();

    // The seam sourced the key from Resource, so the same module-scoped state now decrypts.
    expect(decryptAtRest(cipher)).toBe('sk-secret-from-a-script');
  });
});
