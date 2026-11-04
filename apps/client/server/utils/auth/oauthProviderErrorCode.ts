/** RFC 6749 4.1.2.1 authorization-response error codes a provider may put on `?error=`. */
const PROVIDER_ERROR_CODES = new Set([
  'access_denied',
  'invalid_request',
  'unauthorized_client',
  'unsupported_response_type',
  'invalid_scope',
  'server_error',
  'temporarily_unavailable',
]);

/**
 * The provider's `?error=` value, safe to log: a known RFC 6749 code, `unrecognized` for anything
 * else, or undefined when absent. Callback routes are unauthenticated, so the raw param is caller
 * input and must not reach the logs verbatim.
 */
export function oauthProviderErrorCode(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  return typeof value === 'string' && PROVIDER_ERROR_CODES.has(value) ? value : 'unrecognized';
}
