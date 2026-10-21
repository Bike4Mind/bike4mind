/**
 * The rate-limit headers the API-key rate limiter sets, keyed by name with the
 * description the public docs publish. Single source for the middleware
 * (apps/client/server/middlewares/apiKeyRateLimit.ts), the OpenAPI spec
 * (openapi/document.ts) and the in-app API reference. Renaming a key renames a
 * production response header.
 */
export const API_KEY_RATE_LIMIT_HEADERS = Object.freeze({
  'X-RateLimit-Limit-Minute': 'Request quota per minute.',
  'X-RateLimit-Remaining-Minute': 'Requests remaining in the current minute.',
  'X-RateLimit-Reset-Minute': 'Unix epoch (seconds) when the minute window resets.',
  'X-RateLimit-Limit-Day': 'Request quota per day.',
  'X-RateLimit-Remaining-Day': 'Requests remaining in the current day.',
  'X-RateLimit-Reset-Day': 'Unix epoch (seconds) when the day window resets.',
} as const);

export type ApiKeyRateLimitHeader = keyof typeof API_KEY_RATE_LIMIT_HEADERS;

export const API_KEY_RATE_LIMIT_HEADER_NAMES = Object.freeze(
  Object.keys(API_KEY_RATE_LIMIT_HEADERS) as ApiKeyRateLimitHeader[]
);
