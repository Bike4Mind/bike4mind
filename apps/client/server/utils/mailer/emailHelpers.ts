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
 * Minimal HTML escaper for transactional-email string building. Escapes &, <, >, " - safe for
 * both attribute values (its primary use: alt/src) and element inner text, since the `"` escaping
 * is harmless in text content. Brand name and logo URL come from operator config (process.env),
 * so this is defense-in-depth + consistency rather than a user-input XSS fix, but it keeps the
 * markup well-formed across all builders.
 */
export const escapeHtmlAttr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
  const alt = brand ? `${escapeHtmlAttr(brand)} Logo` : 'Logo';
  return `<img src="${escapeHtmlAttr(logoUrl)}" alt="${alt}" class="logo" />`;
};
