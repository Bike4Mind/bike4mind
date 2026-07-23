import { z } from 'zod';

/** Widget header title; a short label, capped well below anything layout-breaking. */
export const EMBED_BRANDING_DISPLAY_NAME_MAX = 64;

/** De-facto safe URL ceiling; allows CDN query strings, blocks blob smuggling. */
export const EMBED_BRANDING_LOGO_URL_MAX = 2048;

/**
 * Hex-only (#RGB or #RRGGBB). primaryColor is injected into a <style> block on
 * the embed widget page, so the character class alone must make CSS breakout
 * (';', '}', 'url(', whitespace) structurally impossible - no escaping happens
 * at the render site. Named colors and rgb()/rgba() are deliberately rejected.
 */
export const EMBED_BRANDING_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Render-time color sanitizer: canonical lowercase hex, or null. The serve path
 * re-applies this to stored values (they may predate write validation).
 */
export function parseBrandingColor(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return EMBED_BRANDING_COLOR_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * Parse a branding logo URL: https-only absolute URL with a real dotted host,
 * no userinfo, no fragment (path + query allowed, unlike parseEmbedOrigin).
 * Returns the canonical href or null. The https: check is the single guard that
 * rejects javascript:, data:, http: and every other scheme before the value can
 * reach the widget's img.src or the page CSP. Shared by write validation
 * (EmbedBrandingSchema) and the render path (which must not trust stored data).
 */
export function parseBrandingLogoUrl(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > EMBED_BRANDING_LOGO_URL_MAX) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.hash) return null;
  const labels = url.hostname.split('.');
  // Real dotted host, not a bare label. The TLD must contain a letter, which
  // also rejects a trailing dot (empty last label) and a numeric last label /
  // IPv4 literal - matching parseEmbedOrigin's host rule.
  if (labels.length < 2) return null;
  if (!/[a-z]/i.test(labels[labels.length - 1])) return null;
  return url.toString();
}

/**
 * Render-time displayName sanitizer: trimmed and length-capped, or null when
 * blank. Keeps the serve path from trusting a stored value that predates the
 * write-time cap (the widget renders it via textContent, so this is layout
 * hygiene, not an XSS guard).
 */
export function parseBrandingDisplayName(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, EMBED_BRANDING_DISPLAY_NAME_MAX);
}

/**
 * Write-time schema for an embed key's white-label branding. Blank fields are
 * mapped to undefined by the admin client before submit, so there is no
 * empty-string clear path here: a raw API caller clears a field by omitting it
 * (the update path replaces the whole branding object).
 */
export const EmbedBrandingSchema = z.object({
  primaryColor: z
    .string()
    .regex(EMBED_BRANDING_COLOR_PATTERN, 'primaryColor must be a hex color like #336699')
    .optional(),
  logoUrl: z
    .string()
    .max(EMBED_BRANDING_LOGO_URL_MAX)
    .refine(v => parseBrandingLogoUrl(v) !== null, {
      message: 'logoUrl must be an https URL',
    })
    .optional(),
  displayName: z
    .string()
    .max(EMBED_BRANDING_DISPLAY_NAME_MAX)
    .refine(v => v.trim().length > 0, { message: 'displayName cannot be blank' })
    .optional(),
  hideBranding: z.boolean().optional(),
});
