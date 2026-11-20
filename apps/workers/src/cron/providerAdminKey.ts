import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Config } from '@bike4mind/server-utils/utils/config';

export type AdminKeyProvider = 'anthropic' | 'openai';

const NOT_CONFIGURED = 'not-configured';

export interface ProviderAdminKeyLookup {
  key: string | undefined;
  /** When the stored key version was written. Absent without a usable stored key, Config fallback included. */
  createdAt?: Date;
}

/**
 * The provider admin key for the spend crons. Where the secret store exists the env var below holds its
 * secret ARN and the store is the only source; elsewhere (self-host, stages without the store) the
 * Config secret is used. The value is read on every call so a rotated key is picked up by the next run.
 * The env var name must stay in sync with providerAdminKeyEnvName in infra/providerAdminKeys.ts.
 */
export async function lookupProviderAdminKey(provider: AdminKeyProvider): Promise<ProviderAdminKeyLookup> {
  const secretId = process.env[`PROVIDER_ADMIN_KEY_SECRET_${provider.toUpperCase()}`];
  if (!secretId) {
    return { key: provider === 'anthropic' ? Config.ANTHROPIC_ADMIN_API_KEY : Config.OPENAI_ADMIN_API_KEY };
  }

  try {
    const { SecretString, CreatedDate } = await new SecretsManagerClient({}).send(
      new GetSecretValueCommand({ SecretId: secretId })
    );
    const key = SecretString?.trim();
    if (!key || key === NOT_CONFIGURED) return { key: undefined };
    return { key, createdAt: CreatedDate };
  } catch (err) {
    // The secret exists but has no current value yet.
    if (err instanceof Error && err.name === 'ResourceNotFoundException') return { key: undefined };
    throw err;
  }
}

export async function resolveProviderAdminKey(provider: AdminKeyProvider): Promise<string | undefined> {
  return (await lookupProviderAdminKey(provider)).key;
}
