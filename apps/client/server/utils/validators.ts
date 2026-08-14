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
 * True when the given origin - defaulting to APP_URL, but the CSRF middleware also
 * passes an origin built from the request's Origin/Referer header - is the localhost
 * development origin. Used for deciding whether to
 * trust `x-forwarded-proto` / `host` REQUEST HEADERS in place of the configured
 * origin (OAuth callback construction, the CSRF dev-origin allowance).
 *
 * Exactly `localhost`, deliberately NOT validateAppUrl's broader loopback set.
 * That set answers a different and lower-stakes question - may this deployment
 * skip the HTTPS requirement - and the two must not share an answer merely
 * because they share a name. Admitting `127.0.0.1`/`0.0.0.0` here would widen
 * header-trust, and WHATWG parsing normalizes several innocuous-looking values
 * onto them (`http://0`, `http://0x0`, `http://127.1`, `http://2130706433`), so
 * an APP_URL nobody would call a dev override could switch an OAuth redirect_uri
 * onto attacker-influenceable headers. Header-trust gets the narrowest predicate
 * that makes local development work, and nothing more.
 *
 * Replaces `process.env.APP_URL?.includes('localhost')`, which fired for any
 * value merely CONTAINING the word - in a path, or in a longer hostname like
 * `localhost.example.com`.
 *
 * Case-insensitive (the URL parser lowercases `hostname`). A trailing dot
 * (`localhost.`) does NOT match: that is a distinct fully-qualified name.
 *
 * Returns false for an unparseable or absent value - a dev allowance must fail
 * closed, since being wrong that way costs a local convenience while being wrong
 * the other way costs a security property.
 */
export function isLocalAppUrl(appUrl: string | undefined = process.env.APP_URL): boolean {
  if (!appUrl) return false;
  try {
    return new URL(appUrl).hostname === 'localhost';
  } catch {
    return false;
  }
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
