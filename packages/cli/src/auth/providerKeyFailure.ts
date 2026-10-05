import type { ApiErrorCode } from '@bike4mind/common';

const PROVIDER_KEY_ERROR_CODES: ReadonlySet<string> = new Set([
  'provider_not_configured',
  'provider_rejected',
] satisfies ApiErrorCode[]);

/**
 * A 401 whose body names a missing or rejected AI-provider key (e.g. /api/ai/tts). The
 * Bike4Mind credential was accepted, so refreshing or re-authenticating cannot fix it.
 * Shared by the ApiClient refresh interceptor and mapApiError in mcp/b4mApiClient.ts.
 */
export function isProviderKeyFailure(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const { errorCode } = data as Record<string, unknown>;
  return typeof errorCode === 'string' && PROVIDER_KEY_ERROR_CODES.has(errorCode);
}
