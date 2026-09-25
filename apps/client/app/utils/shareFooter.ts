/**
 * Lead-gen footer for published share pages (reply/fabfile viewers + artifact
 * bundles). Pure string builder - NO imports beyond the inlined logo, NO JS -
 * so it's safe under the strict serve CSP (`script-src 'none'`) and passes
 * `validateBundle` (no external asset fetch). Used by `renderViewerPage` (serve
 * handler), `renderArtifactIndexHtml` (server artifact renderer - the permanent
 * home), and `buildArtifactIndexHtml` (client bundler, removed in #1492).
 *
 * Dark-navy card, a brand wordmark (the inlined built-in SVG when the operator
 * opts in via NEXT_PUBLIC_SHARE_BUILTIN_LOGO, otherwise a text wordmark of the
 * brand name), a lime-green accent, and a solid orange CTA linking to the
 * marketing site with UTM attribution.
 */

import { B4M_HORIZONTAL_LOGO_SVG, B4M_FAVICON_SVG } from '@client/app/utils/b4mLogo';
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
/**
 * Icon for the gate panel. Inlined SVG when the operator opts in (no external fetch,
 * passes validateBundle); empty string for forks so they never embed the upstream icon.
 */
function gateIconHtml(): string {
  if (process.env.NEXT_PUBLIC_SHARE_BUILTIN_LOGO === 'true') return B4M_FAVICON_SVG;
  return '';
}

function shareWordmarkHtml(): string {
  if (process.env.NEXT_PUBLIC_SHARE_BUILTIN_LOGO === 'true') return B4M_HORIZONTAL_LOGO_SVG;
  return `<span style="display:block;font-size:20px;font-weight:800;color:#fff;letter-spacing:-.01em">${escapeAttr(
    getBrandName()
  )}</span>`;
}

/**
 * Dismissible sign-up prompt card injected into published artifact pages, offered only to
 * an anonymous visitor at a plain public link (see `signupPrompt` on `renderViewerPage`) --
 * never a share-link holder or a signed-in viewer, both of whom already have full access.
 * It sits in the normal page flow after the content, not over it: the content above it is
 * already fully delivered, so this invites the visitor to make their own rather than
 * pretending to withhold anything. Links to the marketing site signup flow when configured,
 * falling back to the app's own /register so it still renders on a self-hosted deployment.
 *
 * Pure inline CSS + an HTML checkbox-trick dismiss (no JS) so it passes the same
 * `script-src 'none'` CSP constraint as the share footer.
 */
export function buildSignupGateHtml(): { styles: string; html: string } {
  // Link to the marketing site when configured; fall back to the app's own signup page so the
  // gate renders on self-hosted deployments (and in local dev) without a marketing URL.
  const signupHref = SITE_URL
    ? `${SITE_URL}/?utm_source=shared-artifact&utm_medium=signup-gate&utm_campaign=publish`
    : '/register?utm_source=shared-artifact&utm_medium=signup-gate&utm_campaign=publish';
  const brandName = escapeAttr(getBrandName());

  // All gate CSS lives here so the PAGE template injects it into the existing <style> block --
  // avoids a second <style> tag and keeps the page valid. Prefixed b4m-gate-* / b4m-* to
  // avoid collisions with the artifact's own styles.
  const styles = [
    '@keyframes b4m-gatein{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}',
    // Checkbox-trick dismiss: checking the hidden input hides the card.
    '#b4m-gate-dismiss:checked~#b4m-gate-panel{display:none!important}',
    // In-flow card, not a fixed overlay -- it sits after the content (which is already
    // fully rendered above it) and never covers or blocks anything.
    '#b4m-gate-panel{position:relative;margin:2rem auto 0;max-width:860px;background:#fff;',
    'border:1px solid rgba(11,21,36,.1);border-radius:20px;padding:30px 40px 26px;',
    'font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;',
    'animation:b4m-gatein .4s ease both;box-shadow:0 8px 40px rgba(11,21,36,.1)}',
    // Layout.
    '.b4m-gate-inner{display:flex;align-items:center;gap:40px;max-width:860px;margin:0 auto}',
    '.b4m-gate-left{flex:1;min-width:0;text-align:left}',
    '.b4m-gate-right{flex:0 0 340px;display:flex;flex-direction:column;align-items:stretch;gap:12px}',
    // Typography.
    '.b4m-gate-title{margin:12px 0 6px;font-size:22px;font-weight:700;line-height:1.25;color:#0B1524}',
    '.b4m-gate-body{margin:0;font-size:14px;line-height:1.55;color:#5b6878}',
    // Credits inline (no badge box): large number + label side by side.
    '.b4m-credits-inline{display:flex;align-items:baseline;gap:8px;justify-content:flex-end;margin-bottom:4px}',
    '.b4m-credits-num{font:700 34px/1 JetBrains Mono,ui-monospace,monospace;color:#0A7DC1}',
    '.b4m-credits-label{font:600 13px Manrope,sans-serif;color:#6b7787}',
    // CTA button.
    '.b4m-cta-btn{display:block;width:100%;text-align:center;text-decoration:none;background:#17479E;box-sizing:border-box;',
    'color:#fff!important;font-weight:700;font-size:15px;font-family:Sora,system-ui,sans-serif;',
    'border-radius:12px;padding:15px;white-space:nowrap}',
    '.b4m-cta-btn:hover{background:#123a83}',
    // Dismiss label (outlined button style).
    '.b4m-dismiss-label{display:block;width:100%;text-align:center;cursor:pointer;font-family:Manrope,sans-serif;box-sizing:border-box;',
    'font-size:13px;font-weight:600;color:#6b7787;border:1px solid rgba(11,21,36,.14);',
    'border-radius:12px;padding:13px;margin-top:0}',
    '.b4m-dismiss-label:hover{color:#0B1524;border-color:rgba(11,21,36,.3)}',
    // Mobile overrides (1c).
    '@media(max-width:600px){',
    '#b4m-gate-panel{border-radius:20px;padding:22px 22px 26px}',
    '.b4m-gate-inner{flex-direction:column;align-items:stretch;gap:16px}',
    '.b4m-gate-right{flex:none;width:100%;flex-direction:column;align-items:stretch}',
    '.b4m-gate-title{font-size:18px;margin:14px 0 6px}',
    '.b4m-credits-inline{justify-content:flex-start}',
    '.b4m-cta-btn{font-size:15px;padding:15px}',
    '}',
    // Dark mode overrides.
    '@media(prefers-color-scheme:dark){',
    '#b4m-gate-panel{background:#0d1829;border-color:rgba(255,255,255,.1);box-shadow:0 8px 40px rgba(0,0,0,.4)}',
    '.b4m-gate-title{color:#e6e6f0}',
    '.b4m-gate-body{color:#94a3b8}',
    '.b4m-credits-num{color:#29D3F5}',
    '.b4m-credits-label{color:#94a3b8}',
    '.b4m-dismiss-label{color:#94a3b8;border-color:rgba(255,255,255,.15)}',
    '.b4m-dismiss-label:hover{color:#e6e6f0;border-color:rgba(255,255,255,.3)}',
    '}',
  ].join('');

  const html = [
    // Hidden checkbox -- sibling to the panel so the CSS ~ selector can reach it.
    '<input type="checkbox" id="b4m-gate-dismiss" style="display:none">',
    // A non-modal region, not a dialog: it neither covers the content above it nor
    // implies there's more to unlock. `aria-label` matches the visible title below.
    `<div id="b4m-gate-panel" role="region" aria-label="Create a free ${brandName} account">`,
    '<div class="b4m-gate-inner">',
    '<div class="b4m-gate-left">',
    gateIconHtml(),
    `<h2 class="b4m-gate-title">Like this? Make your own with a free ${brandName} account</h2>`,
    `<p class="b4m-gate-body">Create a free ${brandName} account to explore this artifact and build your own \u2014 no credit card required.</p>`,
    '</div>',
    '<div class="b4m-gate-right">',
    '<div class="b4m-credits-inline">',
    '<span class="b4m-credits-num">5,000</span>',
    '<span class="b4m-credits-label">free credits</span>',
    '</div>',
    `<a href="${signupHref}" class="b4m-cta-btn">Create free account</a>`,
    '<label for="b4m-gate-dismiss" class="b4m-dismiss-label">No thanks</label>',
    '</div>',
    '</div>',
    '</div>',
  ].join('');

  return { styles, html };
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
