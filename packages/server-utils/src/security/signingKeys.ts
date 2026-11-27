import { createHmac } from 'crypto';
import { Resource } from 'sst';
import { isPlaceholderImageSigningSecret } from '@bike4mind/common';

/** One value per signed thing, so a key derived for one purpose never signs another. */
export type SigningPurpose = 'search-image-url' | 'telemetry-salt' | 'purge-receipt';

type SecretName = 'HMAC_SIGNING_SECRET' | 'HMAC_SIGNING_SECRET_PREVIOUS' | 'SECRET_ENCRYPTION_KEY';

// Read per call, never at import: several callers avoid module-load Resource access (see
// getDefaultChatCompletionOptions), and an unlinked SST resource throws from its getter.
function readSecret(name: SecretName): string | undefined {
  try {
    const value = (Resource as unknown as Record<string, { value?: unknown } | undefined>)[name]?.value;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

const isConfigured = (value: string | undefined): value is string =>
  value !== undefined && !isPlaceholderImageSigningSecret(value);

const derive = (root: string, purpose: SigningPurpose): string =>
  createHmac('sha256', root).update(`b4m-signing/${purpose}/v1`).digest('hex');

/**
 * Key for new signatures of this purpose: derived from HMAC_SIGNING_SECRET when it is set,
 * otherwise derived from SECRET_ENCRYPTION_KEY. '' when neither is available.
 */
export function signingKey(purpose: SigningPurpose): string {
  const root = readSecret('HMAC_SIGNING_SECRET');
  if (isConfigured(root)) return derive(root, purpose);
  const encryptionKey = readSecret('SECRET_ENCRYPTION_KEY');
  return encryptionKey ? derive(encryptionKey, purpose) : '';
}

/**
 * The key every purpose used before a dedicated secret existed: the raw SECRET_ENCRYPTION_KEY, or
 * ''. For regenerating lookup hashes only; a signature verifier must use `verificationKeys`.
 */
export function legacySigningKey(): string {
  return readSecret('SECRET_ENCRYPTION_KEY') ?? '';
}

/**
 * Keys to accept when verifying or regenerating, newest first. With a dedicated secret set the
 * previous slot adds its derived key and then its raw value, since values signed before per-purpose
 * keys existed were keyed with a raw secret. Empty when nothing usable is configured.
 */
export function verificationKeys(purpose: SigningPurpose): string[] {
  const root = readSecret('HMAC_SIGNING_SECRET');
  if (isConfigured(root)) {
    const keys = [derive(root, purpose)];
    const previous = readSecret('HMAC_SIGNING_SECRET_PREVIOUS');
    if (isConfigured(previous)) keys.push(derive(previous, purpose), previous);
    return keys;
  }
  // The raw key stays accepted for values signed before the fallback was derived per purpose.
  const encryptionKey = readSecret('SECRET_ENCRYPTION_KEY');
  return isConfigured(encryptionKey) ? [derive(encryptionKey, purpose), encryptionKey] : [];
}
