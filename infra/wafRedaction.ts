/**
 * Credential-bearing request headers whose values must never be written to the WAF log.
 *
 * Consumed by the WebACL logging configuration in infra/waf.ts as `redactedFields`: AWS substitutes
 * "REDACTED" for each value at write time while keeping the header name visible in the log record.
 * Names must be lowercase, which is the form WAF matches on.
 *
 * The list is derived from the headers this app actually authenticates with, so adding a new auth
 * header to an API route means adding it here as well. Until that happens
 * apps/client/server/security/wafHeaderRedaction.ts is the second gate: it withholds any header
 * value it does not recognize, so an unlisted header is not exposed through the admin dashboard.
 */
export const WAF_REDACTED_HEADERS: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'x-security-ingest-token',
  'x-e2e-cleanup-secret',
  'x-internal-ws-secret',
  'x-rate-limit-ingest-token',
  'x-webhook-token',
  // Request signatures. Not replayable the way a bearer token is, but each is derived from a shared
  // secret and gets the same handling.
  'stripe-signature',
  'x-hub-signature',
  'x-hub-signature-256',
  'x-slack-signature',
];
