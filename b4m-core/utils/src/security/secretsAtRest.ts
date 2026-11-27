/**
 * Secrets-at-rest key injection.
 *
 * The database layer (packages/database) and core services must encrypt/decrypt
 * stored secrets, but cannot import SST `Config` (that lives in apps/client). The key
 * is held by the keyring (./keyring.ts); in practice `connectDB`
 * (packages/database/src/priceCatalogBootstrap.ts) loads it from `Resource` on every
 * connect, so every process that reaches Mongo - API routes, cron/queue handlers, and
 * the packages/scripts CLIs - is covered without an apps/client-only boot import.
 * Using these helpers before any keyring load throws KeyringNotLoadedError.
 * Read paths call `decryptAtRest`; write paths call `encryptAtRest`.
 *
 * Rollout contract: a value that is NOT in ciphertext format passes through unchanged,
 * so plaintext rows written before the backfill migration keep working until they are
 * re-encrypted. Decryption tries the current key then `SECRET_ENCRYPTION_KEY_PREVIOUS`
 * so a key rotation does not strand values encrypted under the old key.
 */
import { Logger } from '@bike4mind/observability';
import { decryptSecret, encryptSecret, isEncrypted } from './secretEncryption';
import { getAtRestKeys, loadStaticKeyring } from './keyring';

let warnedMissingKey = false;
let warnedDecryptFailure = false;
let warnedPlaintextWrite = false;

/**
 * Synchronously load a static keyring (scripts, tests, self-host). An absent or malformed key
 * loads as "unconfigured" so writes degrade to plaintext rather than throwing on every store.
 * Processes with a KMS-backed key load the keyring with `ensureKeyring` instead.
 */
export function configureSecretsAtRest(key: string | undefined, previous?: string | undefined): void {
  loadStaticKeyring(key, previous);
  // Reset the log-once guards so a genuinely new misconfiguration or decrypt failure after a
  // (re)configuration - e.g. a key rotation - is still surfaced once.
  warnedMissingKey = false;
  warnedDecryptFailure = false;
  warnedPlaintextWrite = false;
}

/** True when a usable encryption key is registered. Throws KeyringNotLoadedError before a keyring loads. */
export function isSecretsAtRestConfigured(): boolean {
  return !!getAtRestKeys().current;
}

/**
 * Encrypt a plaintext secret for storage.
 * - Input is always treated as plaintext, including ciphertext-shaped strings.
 * - When no key is configured, returns the plaintext unchanged so callers that
 *   tolerate unencrypted storage (self-host, per-user keys) keep working. Callers
 *   that must fail closed should check `isSecretsAtRestConfigured()` first.
 */
export function encryptAtRest(plaintext: string, context?: string): string {
  if (!plaintext) return plaintext;
  const { current: currentKey } = getAtRestKeys();
  if (!currentKey) {
    if (isEncrypted(plaintext)) throw new Error('Cannot store ciphertext-shaped input without an encryption key');
    // Degrading to plaintext storage (self-host without a key, or a stage that fails closed
    // upstream before reaching here). Never silent: log once so an operator can see it.
    if (!warnedPlaintextWrite) {
      warnedPlaintextWrite = true;
      Logger.globalInstance.warn(
        '[secrets-at-rest] no SECRET_ENCRYPTION_KEY configured; storing a secret in plaintext at rest'
      );
    }
    return plaintext;
  }
  return encryptSecret(plaintext, currentKey, context);
}

/**
 * Decrypt a value read from storage. Plaintext (pre-migration) values and any
 * non-ciphertext input pass through unchanged. When a ciphertext value cannot be
 * decrypted (no key configured, or none of the keys work after a botched rotation) it
 * returns '' rather than the raw ciphertext: '' makes downstream `if (!key)` guards fire
 * and degrade to the demo-key fallback, whereas returning the hex blob would be sent
 * upstream as a live credential and read as "configured". The failure is logged once.
 */
export function decryptAtRest(value: string, context?: string): string {
  if (!value || !isEncrypted(value)) return value;
  const { current: currentKey, previous: previousKey } = getAtRestKeys();

  if (!currentKey && !previousKey) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      Logger.globalInstance.error(
        '[secrets-at-rest] read an encrypted value but no SECRET_ENCRYPTION_KEY is configured; cannot decrypt'
      );
    }
    return '';
  }

  for (const key of [currentKey, previousKey]) {
    if (!key) continue;
    try {
      return decryptSecret(value, key, context);
    } catch {
      // Try the next key (rotation) before giving up.
    }
  }

  if (!warnedDecryptFailure) {
    warnedDecryptFailure = true;
    Logger.globalInstance.error('[secrets-at-rest] failed to decrypt a stored secret with the configured key(s)');
  }
  return '';
}
