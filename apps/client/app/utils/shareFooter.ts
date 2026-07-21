/**
 * Lead-gen footer for published share pages (reply/fabfile viewers + artifact
 * bundles). Pure string builder - NO imports beyond the inlined logo, NO JS -
 * so it's safe under the strict serve CSP (`script-src 'none'`) and passes
 * `validateBundle` (no external asset fetch). Used by both `renderViewerPage`
 * (serve handler) and `buildArtifactIndexHtml` (client bundler).
 *
 * Dark-navy card, a brand wordmark (the inlined built-in SVG when the operator
 * opts in via NEXT_PUBLIC_SHARE_BUILTIN_LOGO, otherwise a text wordmark of the
 * brand name), a lime-green accent, and a solid orange CTA linking to the
 * marketing site with UTM attribution.
 */

import { B4M_HORIZONTAL_LOGO_SVG } from '@client/app/utils/b4mLogo';
// Marketing-site URL sourced from config (empty when unconfigured).
import { WEBSITE_URL, getBrandName } from '@client/config/general';
import { escapeAttr } from './htmlEscape';

const SITE_URL = WEBSITE_URL;

// Share-footer palette - configurable for forks via NEXT_PUBLIC_SHARE_BRAND_*,
// defaulting to the project's own palette so the hosted look is unchanged.
const BRAND_NAVY = process.env.NEXT_PUBLIC_SHARE_BRAND_NAVY || '#0d1830';
const BRAND_LIME = process.env.NEXT_PUBLIC_SHARE_BRAND_LIME || '#84CC16';
const BRAND_ORANGE = process.env.NEXT_PUBLIC_SHARE_BRAND_ORANGE || '#F26C1F';

export interface ShareFooterOptions {
  /** Optional "Shared by {name}" attribution line. */
  sharedBy?: string;
  /** Distinguishes which surface drove the click (utm_content). */
  source?: 'reply' | 'fabfile' | 'artifact' | 'bundle';
  /**
   * When set, render a subtle "Report this page" link to the app-origin report
   * flow (/report/{publicId}). A plain anchor (no JS) so it stays valid under
   * the strict serve CSP (`script-src 'none'`). Omitted for client-built bundle
   * footers, where the publicId isn't known until finalize.
   */
  reportPublicId?: string;
}

/**
 * Wordmark for the share footer. The inline SVG in b4mLogo.ts is the project's
 * OWN brand artwork, so it only renders when the operator opts in via
 * NEXT_PUBLIC_SHARE_BUILTIN_LOGO=true. A fork renders its brand name as a CSP-safe text wordmark
 * instead, so a fork's share pages never embed the upstream logo. Both paths are inline (no
 * external fetch) to stay valid under the strict serve CSP (`script-src 'none'`).
 */
function shareWordmarkHtml(): string {
  if (process.env.NEXT_PUBLIC_SHARE_BUILTIN_LOGO === 'true') return B4M_HORIZONTAL_LOGO_SVG;
  return `<span style="display:block;font-size:20px;font-weight:800;color:#fff;letter-spacing:-.01em">${escapeAttr(
    getBrandName()
  )}</span>`;
}

/** Returns the footer as an HTML string ready to inject before `</body>`. */
export function buildShareFooterHtml(opts: ShareFooterOptions = {}): string {
  // The footer is a brand lead-gen card (inlined brand wordmark + a CTA to the marketing
  // site). With no marketing URL configured there is nothing to link to and
  // the brand wordmark shouldn't ship - render nothing rather than a self-referential `/?utm`
  // CTA and a hardcoded logo.
  if (!SITE_URL) return '';
  const utm = `utm_source=shared-artifact&utm_medium=share-footer&utm_campaign=publish${
    opts.source ? `&utm_content=${opts.source}` : ''
  }`;
  const href = `${SITE_URL}/?${utm}`;
  const sharedBy = opts.sharedBy
    ? `<span style="display:block;margin-top:2px;opacity:.6;font-size:12px;color:#cbd5e1">Shared by ${escapeAttr(opts.sharedBy)}</span>`
    : '';

  // Abuse-report link. Root-relative so it resolves to the app origin
  // (e.g. app.example.com/report/{id}); rel=nofollow keeps crawlers off it.
  const report = opts.reportPublicId
    ? `<div style="margin-top:10px;text-align:center;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif">
    <a href="/report/${encodeURIComponent(opts.reportPublicId)}" rel="nofollow"
       style="font-size:11.5px;color:#94a3b8;text-decoration:none">⚑ Report this page</a>
  </div>`
    : '';

  // Self-contained navy card (inline styles only) so it renders consistently on
  // any host page, light or dark.
  return `<div style="margin-top:3rem;display:flex;justify-content:center;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif">
  <a href="${href}" target="_blank" rel="noopener noreferrer"
     style="display:flex;align-items:center;gap:16px;max-width:600px;width:100%;padding:14px 18px;
            border:1px solid rgba(255,255,255,.14);border-radius:14px;text-decoration:none;
            background:${BRAND_NAVY};box-shadow:0 6px 24px rgba(0,0,0,.25)">
    <span style="flex:1;min-width:0">
      ${shareWordmarkHtml()}
      <span style="display:block;margin-top:7px;font-size:12.5px;color:#9fb3c8;line-height:1.4">
        <span style="color:${BRAND_LIME};font-weight:700">✓</span> Create &amp; share AI artifacts like this — in seconds.
      </span>
      ${sharedBy}
    </span>
    <span style="flex:0 0 auto;padding:9px 15px;border-radius:10px;font-weight:700;font-size:13px;white-space:nowrap;
                 background:${BRAND_ORANGE};color:#fff">Try ${escapeAttr(getBrandName())} →</span>
  </a>
</div>${report}`;
}
