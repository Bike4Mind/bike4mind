import { getWebsiteUrl, WEBSITE_URL } from '@client/config/general';

/**
 * Common external links used throughout the application
 */
export const ExternalLinks = {
  website: WEBSITE_URL,
  terms: getWebsiteUrl('terms-of-service'),
  usagePolicy: getWebsiteUrl('usage-policy'),
  privacy: getWebsiteUrl('privacy'),
  // AUP/ToS acceptance gate. The marketing-site page for this slug may 404
  // until the legal text ships; the acceptance mechanism does not depend on the page existing.
  acceptableUse: getWebsiteUrl('acceptable-use'),
  pricing: getWebsiteUrl('pricing'),
  manual: getWebsiteUrl('manual'),
  support: getWebsiteUrl('support'),
  blog: getWebsiteUrl('blog'),
  changelog: getWebsiteUrl('changelog'),
  about: getWebsiteUrl('about'),
};

/**
 * `sx` for a `<Link>` placed inside a MUI Joy `Checkbox`/`Radio` `label`.
 *
 * MUI Joy renders the control's clickable area as an absolutely-positioned "action" overlay
 * (containing the transparent `<input>`) at `zIndex: 1` covering the whole control, so a click on
 * a nested link lands on the overlay and toggles the box instead of opening the link.
 * `position: relative` + `zIndex: 2` promotes the link above that overlay so the anchor becomes the
 * click target. `position` is required because `zIndex` is a no-op on statically-positioned
 * elements - both are needed. (`onClick` stopPropagation does NOT work: the click never reaches the
 * anchor to propagate from.) See #59.
 */
export const CHECKBOX_LABEL_LINK_SX = { position: 'relative', zIndex: 2 } as const;

/**
 * Opens a URL in a new browser TAB (not a popup window) with full
 * `noopener,noreferrer` protection.
 *
 * Why a transient anchor click rather than window.open: passing ANY feature
 * string to window.open - even just 'noopener' - makes the browser spawn a popup
 * WINDOW instead of a tab, but it's also the only way window.open can suppress
 * the referrer. An `<a target="_blank" rel="noopener noreferrer">` resolves both
 * at once: it opens a TAB and applies both protections AT OPEN TIME (no window
 * to null `opener` on after the fact, and no referrer leak to the destination).
 *
 * Accepts a nullable URL and no-ops on a falsy one - many call sites pass an
 * optional `task.url`/`meta.externalUrl`, and opening `undefined` is never what
 * we want. Only available in browser environments.
 * @param url The fully-resolved URL to open
 */
export const openInNewTab = (url: string | null | undefined): void => {
  if (typeof window === 'undefined' || !url) return;
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  (document.body ?? document.documentElement).appendChild(anchor);
  anchor.click();
  anchor.remove();
};

/**
 * Opens an external link in a new tab with security best practices
 * Only available in browser environments
 * @param url The URL to open
 * @param isWebsitePath If true, the URL is treated as a path relative to the website URL
 */
export const openExternalLink = (url: string, isWebsitePath: boolean = false): void => {
  if (typeof window === 'undefined') return;

  const targetUrl = isWebsitePath ? getWebsiteUrl(url) : url;
  openInNewTab(targetUrl);
};

/**
 * Opens one of the predefined external links
 * Only available in browser environments
 * @param linkKey The key of the link to open
 */
export const openExternalLinkByKey = (linkKey: keyof typeof ExternalLinks): void => {
  if (typeof window === 'undefined') return;

  const link = ExternalLinks[linkKey];
  if (typeof link === 'string') {
    openExternalLink(link);
    console.log('Opened link:', link);
  }
};
