/**
 * Secrets-at-rest key injection.
 *
 * The database layer (packages/database) and core services must encrypt/decrypt
 * stored secrets, but cannot import SST `Config` (that lives in apps/client). The
 * app injects the encryption key once at boot via `configureSecretsAtRest`, and the
 * repository read paths call `decryptAtRest` / write paths call `encryptAtRest`.
 *
 * Mirrors the `setModelCatalogProvider` one-time-injection pattern used by connectDB.
 *
 * Rollout contract: a value that is NOT in ciphertext format passes through unchanged,
 * so plaintext rows written before the backfill migration keep working until they are
 * re-encrypted. Decryption tries the current key then `SECRET_ENCRYPTION_KEY_PREVIOUS`
 * so a key rotation does not strand values encrypted under the old key.
 */
import { Logger } from '@bike4mind/observability';
import { decryptSecret, encryptSecret, isEncrypted, isValidEncryptionKey } from './secretEncryption';

let currentKey: string | undefined;
let previousKey: string | undefined;
let warnedMissingKey = false;
let warnedDecryptFailure = false;

/**
 * Register the at-rest encryption key(s). Called once from app boot with
 * `Config.SECRET_ENCRYPTION_KEY` (and optionally the previous key during rotation).
 * An absent or malformed key registers as "unconfigured" so writes degrade to
 * plaintext (self-host without a key) rather than throwing on every store.
 */
export function configureSecretsAtRest(key: string | undefined, previous?: string | undefined): void {
  currentKey = key && isValidEncryptionKey(key) ? key : undefined;
  previousKey = previous && isValidEncryptionKey(previous) ? previous : undefined;
}

/** True when a usable encryption key is registered. */
export function isSecretsAtRestConfigured(): boolean {
  return !!currentKey;
}

/**
 * Encrypt a plaintext secret for storage.
 * - Already-ciphertext input is returned unchanged (idempotent).
 * - When no key is configured, returns the plaintext unchanged so callers that
 *   tolerate unencrypted storage (self-host, per-user keys) keep working. Callers
 *   that must fail closed should check `isSecretsAtRestConfigured()` first.
 */
export function encryptAtRest(plaintext: string): string {
  if (!plaintext || isEncrypted(plaintext)) return plaintext;
  if (!currentKey) return plaintext;
  return encryptSecret(plaintext, currentKey);
}

/**
 * Decrypt a value read from storage. Plaintext (pre-migration) values and any
 * non-ciphertext input pass through unchanged. On a genuine decrypt failure the
 * ciphertext is returned as-is (fail-broken, never a silent plaintext leak) and the
 * failure is logged once.
 */
export function decryptAtRest(value: string): string {
  if (!value || !isEncrypted(value)) return value;

  if (!currentKey && !previousKey) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      Logger.globalInstance.error(
        '[secrets-at-rest] read an encrypted value but no SECRET_ENCRYPTION_KEY is configured; cannot decrypt'
      );
    }
    return value;
  }

  for (const key of [currentKey, previousKey]) {
    if (!key) continue;
    try {
      return decryptSecret(value, key);
    } catch {
      // Try the next key (rotation) before giving up.
    }
  }

  if (!warnedDecryptFailure) {
    warnedDecryptFailure = true;
    Logger.globalInstance.error('[secrets-at-rest] failed to decrypt a stored secret with the configured key(s)');
  }
  return value;
}
