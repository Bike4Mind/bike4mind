/**
 * Email verification helper utilities
 */
import { requireEnv } from '@bike4mind/common';
import { escapeHtml } from '@bike4mind/utils/escapeHtml';

// Re-exported so the email builders keep importing their escaper from here.
export { escapeHtml };

/**
 * Generates a verification link for email verification. The email-change mailer reuses it with the
 * path swapped to /verify-change.
 *
 * The token rides in the URL fragment, not the query: a browser never sends the fragment to a server,
 * so the token stays out of access logs, edge logs and Referer headers. The client route takes it out
 * of the address before it calls the API (apps/client/app/utils/emailLinkToken.ts), and still accepts
 * the older `?token=` form from links already sent.
 * @param token - The verification token
 * @returns The full verification link URL
 */
export const generateVerificationLink = (token: string): string => {
  // APP_URL is set per-deployment by infra; no brand fallback.
  const baseUrl = requireEnv('APP_URL', process.env.APP_URL);
  return `${baseUrl}/verify-email#token=${encodeURIComponent(token)}`;
};

/**
 * Gets the logo URL for email templates
 * @returns The logo URL, or an empty string when LOGO_URL is unconfigured
 *          (account-tied brand asset; no brand fallback).
 */
export const getLogoUrl = (): string => {
  return process.env.LOGO_URL ?? '';
};

/**
 * Build the brand logo `<img>` for transactional emails, with both `alt` and `src` HTML-escaped.
 * Centralizes logo markup + escaping previously duplicated across ~13 email builders with
 * inconsistent escaping. Returns '' when no logo is configured (no brand fallback) so callers
 * can drop it in unconditionally without a separate `logoUrl ? ... : ''` guard.
 *
 * @param brand - Brand/display name (e.g. APP_NAME); when empty the alt is just "Logo".
 * @param logoUrl - Logo URL; defaults to {@link getLogoUrl}. Empty => returns ''.
 */
export const buildEmailLogoImg = (brand: string, logoUrl: string = getLogoUrl()): string => {
  if (!logoUrl) return '';
  const alt = brand ? `${escapeHtml(brand)} Logo` : 'Logo';
  return `<img src="${escapeHtml(logoUrl)}" alt="${alt}" class="logo" />`;
};
