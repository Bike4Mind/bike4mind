import { encryptSecret, decryptSecret, isEncrypted, isValidEncryptionKey } from './secretEncryption';
import { Config } from '@server/utils/config';

function requireKey(): string {
  const key = Config.SECRET_ENCRYPTION_KEY;
  if (!key) throw new Error('SECRET_ENCRYPTION_KEY is not configured');
  return key;
}

function previousKey(): string | null {
  const key = Config.SECRET_ENCRYPTION_KEY_PREVIOUS;
  if (!key || key === 'not-configured' || !isValidEncryptionKey(key)) return null;
  return key;
}

/** Encrypts a token value. Returns null if value is null/undefined. Idempotent - skips already-encrypted values. */
export function encryptToken(value: string | null | undefined): string | null {
  if (!value) return null;
  if (isEncrypted(value)) return value;
  return encryptSecret(value, requireKey());
}

/**
 * Decrypts a token value. Tries the current key first, then falls back to the
 * previous key for seamless key rotation. Returns null if value is null/undefined.
 * Passes through plaintext values for backward compatibility during migration.
 */
export function decryptToken(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!isEncrypted(value)) return value;

  const keysToTry = [requireKey(), previousKey()].filter(Boolean) as string[];
  let lastError: unknown;

  for (const key of keysToTry) {
    try {
      return decryptSecret(value, key);
    } catch (err) {
      lastError = err;
    }
  }

  const hasPrevious = keysToTry.length > 1;
  const errorDetail = lastError instanceof Error ? lastError.message : String(lastError);
  const context = hasPrevious ? 'both current and previous keys' : 'no previous key configured';
  console.error(`[tokenEncryption] Decryption failed (${context}): ${errorDetail}`);

  throw new Error(
    hasPrevious
      ? 'Token decryption failed — value may be corrupted or encrypted with an unknown key'
      : 'Token decryption failed — check SECRET_ENCRYPTION_KEY'
  );
}

export type EnvVariable = { key: string; value: string };

/** Encrypts the value of every item in an envVariables array. */
export function encryptEnvVariables(vars: EnvVariable[]): EnvVariable[] {
  const key = requireKey();
  return vars.map(v => ({
    key: v.key,
    value: isEncrypted(v.value) ? v.value : encryptSecret(v.value, key),
  }));
}

/** Decrypts the value of every item in an envVariables array. Uses key rotation fallback. */
export function decryptEnvVariables(vars: EnvVariable[]): EnvVariable[] {
  return vars.map(v => ({
    key: v.key,
    value: decryptToken(v.value) ?? v.value,
  }));
}
