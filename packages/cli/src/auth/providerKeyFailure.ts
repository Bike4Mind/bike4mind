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
  const body = decodeBinaryBody(data);
  if (!body || typeof body !== 'object') return false;
  const { errorCode } = body as Record<string, unknown>;
  return typeof errorCode === 'string' && PROVIDER_KEY_ERROR_CODES.has(errorCode);
}

/**
 * An arraybuffer-typed request (the generated-audio calls) gets its error body as raw
 * bytes, and the refresh interceptor sees it before any caller can decode it.
 */
function decodeBinaryBody(data: unknown): unknown {
  const bytes =
    data instanceof ArrayBuffer
      ? Buffer.from(data)
      : ArrayBuffer.isView(data)
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : undefined;
  if (!bytes) return data;
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    // Not a JSON error body, so it cannot name a provider-key failure.
    return undefined;
  }
}
