import { configureSecretsAtRest, isSecretsAtRestConfigured } from '@bike4mind/utils/security';
import type { Logger } from '@bike4mind/observability';

/**
 * Registers the at-rest key on the utils instance this (CommonJS) process graph resolves, which is
 * the one @bike4mind/services reads. connectDB only configures the ESM copy its own graph loads
 * (see esmWorkspacePackages.mjs), so without this the services-side decryptAtRest has no key.
 * Returns false (and logs) when no usable key ended up registered. Exported for tests.
 */
export function registerSecretsAtRest(
  logger: Pick<Logger, 'error'>,
  key: string | undefined,
  previousKey?: string
): boolean {
  configureSecretsAtRest(key, previousKey);
  if (isSecretsAtRestConfigured()) return true;
  logger.error(
    'Secrets-at-rest key is not registered on the utils instance services read; ' +
      'stored credentials read by services tools will not decrypt'
  );
  return false;
}
