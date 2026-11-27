import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import { SST_PLACEHOLDER_VALUE } from '@bike4mind/common';
import { SystemSecretsSeeder } from './SystemSecretsSeeder';

const resource = vi.hoisted(() => ({}) as Record<string, { value?: string }>);
vi.mock('sst', () => ({ Resource: resource }));

const VALID_SECRETS = {
  SECRET_ENCRYPTION_KEY: 'a'.repeat(64),
  SESSION_SECRET: 's'.repeat(48),
  JWT_SECRET: 'j'.repeat(64),
};

const logger = {
  info: vi.fn(),
  withMetadata(): Logger {
    return this as unknown as Logger;
  },
} as unknown as Logger;

function setSecrets(values: Record<string, string>): void {
  for (const key of Object.keys(resource)) delete resource[key];
  for (const [name, value] of Object.entries(values)) resource[name] = { value };
}

describe('SystemSecretsSeeder', () => {
  beforeEach(() => setSecrets(VALID_SECRETS));
  afterEach(() => vi.unstubAllEnvs());

  it('passes when every Tier 1 secret is configured', async () => {
    await expect(new SystemSecretsSeeder(logger).seed()).resolves.toBeUndefined();
  });

  it.each([SST_PLACEHOLDER_VALUE, 'change-me-openssl-rand-hex-32', ''])(
    'refuses JWT_SECRET=%j on a preview stage',
    async placeholder => {
      vi.stubEnv('IS_PREVIEW', 'true');
      setSecrets({ ...VALID_SECRETS, JWT_SECRET: placeholder });

      await expect(new SystemSecretsSeeder(logger).seed()).rejects.toThrow(
        /REQUIRED SECRET NOT CONFIGURED[\s\S]*JWT_SECRET/
      );
    }
  );

  it('refuses a placeholder SESSION_SECRET on a preview stage', async () => {
    vi.stubEnv('IS_PREVIEW', 'true');
    setSecrets({ ...VALID_SECRETS, SESSION_SECRET: SST_PLACEHOLDER_VALUE });

    await expect(new SystemSecretsSeeder(logger).seed()).rejects.toThrow(/SESSION_SECRET/);
  });

  it('refuses a Tier 1 secret that is missing entirely', async () => {
    setSecrets({ SESSION_SECRET: VALID_SECRETS.SESSION_SECRET, JWT_SECRET: VALID_SECRETS.JWT_SECRET });

    await expect(new SystemSecretsSeeder(logger).seed()).rejects.toThrow(/SECRET_ENCRYPTION_KEY/);
  });
});
