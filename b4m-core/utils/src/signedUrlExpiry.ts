const AMZ_DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
// The signer can only clamp to a credential expiration it is told about; some runtimes'
// credentials report none. Never trust a cached link longer than this so a dead one self-heals.
const MAX_CACHED_URL_SECONDS = 3600;

/**
 * When to stop serving a freshly signed URL from a cache (a FabFile row, getCachedSignedUrl).
 * An S3 signer may shorten the requested lifetime to that of its credentials
 * (fab-pipeline S3Storage.getSignedUrl), so read it from the SigV4 query (X-Amz-Date +
 * X-Amz-Expires); a URL without them (non-S3 adapter) gets the requested lifetime. Either way
 * the result is capped at MAX_CACHED_URL_SECONDS from now.
 */
export const signedUrlExpiresAt = (fileUrl: string, requestedSeconds: number): Date => {
  const fallback = new Date(Date.now() + Math.min(requestedSeconds, MAX_CACHED_URL_SECONDS) * 1000);
  let params: URLSearchParams;
  try {
    params = new URL(fileUrl).searchParams;
  } catch {
    return fallback;
  }
  const date = AMZ_DATE_PATTERN.exec(params.get('X-Amz-Date') ?? '');
  const expires = Number(params.get('X-Amz-Expires'));
  if (!date || !Number.isFinite(expires) || expires <= 0) return fallback;
  const [, year, month, day, hour, minute, second] = date.map(Number);
  const signedAt = Date.UTC(year, month - 1, day, hour, minute, second);
  return new Date(Math.min(signedAt + expires * 1000, fallback.getTime()));
};
