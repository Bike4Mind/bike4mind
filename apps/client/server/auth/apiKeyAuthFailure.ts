import { HTTPError } from '@bike4mind/common';
import { isConnectionLostError } from '@bike4mind/db-core';
import { InternalServerError, ServiceUnavailableError } from '@bike4mind/server-utils/utils/errors';

/** Seconds a client should wait before retrying when the database is unreachable. */
export const AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/**
 * Classify an error thrown while verifying an API key. A credential verdict (an HTTPError such as
 * 401/403) passes through; anything else is our fault, not the key's: a lost database connection is
 * a 503 and the rest a 500. A 401 there would tell a machine client its key is bad and stop it
 * retrying an infra blip. Messages are fixed because this runs before auth, so driver text (hosts,
 * ports) must not reach the caller.
 *
 * Shared by every API-key verifier (the apiKeyAuth middleware, verifyApiKey, verifyEmbedKeyById);
 * transports then branch on {@link isAuthInfraFailure} ahead of their own 401/403 handling.
 */
export function toApiKeyAuthError(error: unknown): HTTPError {
  if (error instanceof HTTPError) return error;
  if (isConnectionLostError(error)) {
    return new ServiceUnavailableError('Authentication temporarily unavailable', {
      retryAfter: AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS,
    });
  }
  return new InternalServerError('Authentication failed');
}

/** True when an auth check failed on our side (a 5xx from {@link toApiKeyAuthError}), not on the credential. */
export function isAuthInfraFailure(error: unknown): error is HTTPError {
  return error instanceof HTTPError && error.statusCode >= 500;
}

/** The `retryAfter` (seconds) a {@link toApiKeyAuthError} 503 carries, for transports without headers. */
export function authRetryAfterSeconds(error: HTTPError): number | undefined {
  const retryAfter = error.additionalInfo?.retryAfter;
  return typeof retryAfter === 'number' ? retryAfter : undefined;
}

/** Response headers for a {@link isAuthInfraFailure} error: `Retry-After` when it carries one. */
export function authInfraFailureHeaders(error: HTTPError): Record<string, string> {
  const retryAfter = authRetryAfterSeconds(error);
  return retryAfter === undefined ? {} : { 'Retry-After': String(retryAfter) };
}

/** Set {@link authInfraFailureHeaders} on a Node/Express/Next response before sending its body. */
export function setAuthInfraFailureHeaders(res: { setHeader(name: string, value: string): unknown }, error: HTTPError) {
  for (const [name, value] of Object.entries(authInfraFailureHeaders(error))) res.setHeader(name, value);
}
