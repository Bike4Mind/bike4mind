import { encryptSecret, decryptSecret, isEncrypted } from './secretEncryption';
import { getAtRestKeys, mcpEnvSecretContext } from '@bike4mind/utils/security';
import { Logger } from '@bike4mind/observability';

function requireKey(): string {
  const key = getAtRestKeys().current;
  if (!key) throw new Error('SECRET_ENCRYPTION_KEY is not configured');
  return key;
}

function previousKey(): string | null {
  return getAtRestKeys().previous ?? null;
}

/** Encrypts submitted plaintext, even when it has the shape of stored ciphertext. */
export function encryptToken(value: string | null | undefined, context?: string): string | null {
  if (!value) return null;
  return encryptSecret(value, requireKey(), context);
}

/**
 * Decrypts a token value. Tries the current key first, then falls back to the
 * previous key for seamless key rotation. Returns null if value is null/undefined.
 * Passes through plaintext values for backward compatibility during migration.
 */
export function decryptToken(value: string | null | undefined, context?: string): string | null {
  if (!value) return null;
  if (!isEncrypted(value)) return value;

  const keysToTry = [requireKey(), previousKey()].filter(Boolean) as string[];
  let lastError: unknown;

  for (const key of keysToTry) {
    try {
      return decryptSecret(value, key, context);
    } catch (err) {
      lastError = err;
    }
  }

  const hasPrevious = keysToTry.length > 1;
  const errorDetail = lastError instanceof Error ? lastError.message : String(lastError);
  const errorContext = hasPrevious ? 'both current and previous keys' : 'no previous key configured';
  Logger.error(`[tokenEncryption] Decryption failed (${errorContext}): ${errorDetail}`);

  throw new Error(
    hasPrevious
      ? 'Token decryption failed \u2014 value may be corrupted or encrypted with an unknown key'
      : 'Token decryption failed \u2014 check SECRET_ENCRYPTION_KEY'
  );
}

/**
 * Decrypts a value that is only ever stored as ciphertext. Same key order as decryptToken, but
 * anything that is not ciphertext throws instead of passing through, and a total failure rethrows
 * the current key's own error so callers that classify the failure by message keep working.
 */
export function decryptStoredSecret(value: string, context?: string): string {
  const current = requireKey();
  try {
    return decryptSecret(value, current, context);
  } catch (currentKeyError) {
    const previous = previousKey();
    if (previous) {
      try {
        return decryptSecret(value, previous, context);
      } catch {
        // Neither key opens it: report the current key's error below.
      }
    }
    throw currentKeyError;
  }
}

export type McpSecretOwner = { userId: string; name?: string; id: string };

function envContext(owner: McpSecretOwner, field: string): string {
  return mcpEnvSecretContext(owner.userId, owner.id, field);
}

export type EnvVariable = { key: string; value: string };

/** Encrypts the value of every item in an envVariables array. */
export function encryptEnvVariables(vars: EnvVariable[], owner: McpSecretOwner): EnvVariable[] {
  const key = requireKey();
  return vars.map(v => ({
    key: v.key,
    value: v.value ? encryptSecret(v.value, key, envContext(owner, v.key)) : '',
  }));
}

/** Decrypts the value of every item in an envVariables array. Uses key rotation fallback. */
export function decryptEnvVariables(vars: EnvVariable[], owner: McpSecretOwner): EnvVariable[] {
  return vars.map(v => ({
    key: v.key,
    value: decryptToken(v.value, envContext(owner, v.key)) ?? v.value,
  }));
}
