/**
 * Shared validation utilities for server-side code.
 */
import { Logger } from '@bike4mind/observability';

/**
 * Validates PEM format for private keys.
 * Accepts RSA, EC, or generic private keys with LF or CRLF line endings.
 *
 * @param key - The private key string to validate
 * @returns true if the key is in valid PEM format
 */
export function validatePrivateKeyFormat(key: string): boolean {
  // Check for proper PEM structure with headers and base64 content
  // Use [\r\n]+ to accept both LF (\n) and CRLF (\r\n) line endings
  const pemRegex =
    /^-----BEGIN (RSA |EC |)PRIVATE KEY-----[\r\n]+[\s\S]+[\r\n]+-----END (RSA |EC |)PRIVATE KEY-----\s*$/;
  return pemRegex.test(key.trim());
}

/**
 * Validates APP_URL environment variable.
 * Must be set and be a valid URL (HTTPS in production, HTTP allowed for localhost).
 *
 * @param context - Optional context string for log messages (e.g., 'Okta Auth', 'SAML Callback')
 * @returns The validated APP_URL or null if invalid/missing
 */
export function validateAppUrl(context?: string): string | null {
  const appUrl = process.env.APP_URL;
  const logPrefix = context ? `[${context}]` : '[validateAppUrl]';

  if (!appUrl) {
    return null;
  }

  try {
    const url = new URL(appUrl);
    // Allow HTTP only for localhost (development) - includes 0.0.0.0 for Docker/container environments
    const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '0.0.0.0';
    if (url.protocol !== 'https:' && !isLocalhost) {
      Logger.error(`${logPrefix} APP_URL must use HTTPS in production:`, appUrl);
      return null;
    }
    return appUrl;
  } catch {
    Logger.error(`${logPrefix} APP_URL is not a valid URL:`, appUrl);
    return null;
  }
}
