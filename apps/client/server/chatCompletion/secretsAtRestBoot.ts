import { isKeyringLoaded, isSecretsAtRestConfigured } from '@bike4mind/utils/security';
import type { Logger } from '@bike4mind/observability';

/**
 * Loads the at-rest keyring (via `load`, the database package's loader) and checks it is visible
 * from the utils instance this (CommonJS) process graph resolves, which is the one
 * @bike4mind/services reads. The keyring lives on globalThis, so the ESM copy the database package
 * loads and this CJS copy share it; the check guards that invariant.
 * Returns false (and logs) when no usable key ended up loaded. Called at ChatCompletion boot.
 */
export async function ensureSecretsAtRest(logger: Pick<Logger, 'error'>, load: () => Promise<void>): Promise<boolean> {
  try {
    await load();
  } catch (err) {
    logger.error('Secrets-at-rest keyring failed to load; it will be retried on the next database connect', err);
  }
  if (isKeyringLoaded() && isSecretsAtRestConfigured()) return true;
  logger.error(
    'Secrets-at-rest key is not loaded on the utils instance services read; ' +
      'stored credentials read by services tools will not decrypt'
  );
  return false;
}
