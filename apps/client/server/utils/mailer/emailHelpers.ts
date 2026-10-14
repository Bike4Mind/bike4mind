/**
 * Email verification helper utilities
 */
import { requireEnv } from '@bike4mind/common';

/**
 * Generates a verification link for email verification
 * @param token - The verification token
 * @returns The full verification link URL
 */
export const generateVerificationLink = (token: string): string => {
  // APP_URL is set per-deployment by infra; no brand fallback.
  const baseUrl = requireEnv('APP_URL', process.env.APP_URL);
  return `${baseUrl}/verify-email?token=${token}`;
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
 * HTML escaper for every value interpolated into a transactional-email body: escapes & < > " ',
 * so the result is safe both as element text and inside a quoted attribute. Apply it to anything
 * a user or operator can influence (usernames, names, emails, org and file names); never to a
 * plain-text subject, which is not HTML.
 */
export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

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
