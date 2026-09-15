import queryString from 'query-string';
import crypto from 'crypto';

export function generateTemporarySignedUrl(
  url: string,
  params: Record<string, unknown>,
  secretKey: string,
  expiresInMinutes: number
): string {
  const expiration = Math.floor(Date.now() / 1000) + expiresInMinutes * 60;
  const queryParams = { ...params, expires: expiration };
  const queryStringified = queryString.stringify(queryParams);

  // Create a HMAC SHA-256 hash of the serialized query
  const signature = crypto.createHmac('sha256', secretKey).update(queryStringified).digest('hex');
  const signedQueryString = queryString.stringify({ ...queryParams, signature });

  return `${url}?${signedQueryString}`;
}
