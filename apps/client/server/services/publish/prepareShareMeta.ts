import { escapeHtml } from './viewerSecurity';

/**
 * Build the server-rendered head-meta and noscript body a public share needs to
 * be legible to agents (unfurlers, LLM URL fetchers, non-JS crawlers). Callers
 * pass raw text/HTML; escaping happens here at the point of interpolation, so
 * the returned strings are safe to splice directly into a wrapper page.
 *
 * Applies to public shares only. Gated bundles must NOT emit meta/noscript that
 * leak artifact content pre-auth - the loader shell stays deliberately blank.
 */

const MAX_DESCRIPTION_LEN = 300;
const MAX_EXCERPT_LEN = 1500;

/** Strip HTML tags, drop script/style/comment contents, decode common entities, collapse whitespace. */
export function stripToText(input: string, max: number): string {
  if (!input) return '';
  const stripped = input
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length <= max) return stripped;
  return stripped.slice(0, Math.max(0, max - 3)).trimEnd() + '...';
}

export interface ShareMetaInput {
  title: string;
  /** Author-supplied description (already plain text). Preferred for og:description. */
  description?: string;
  /** Raw HTML/markdown/text body; used to derive the excerpt (and description fallback). */
  bodyForExcerpt?: string;
  canonicalUrl: string;
  /** Alternate plain-text URL for the same artifact; empty disables the alternate link. */
  rawUrl?: string;
  /** Optional site name for og:site_name. */
  siteName?: string;
}

export interface ShareMetaOutput {
  /** `<meta>` + `<link rel="canonical">` head block (newline-joined). */
  metaTags: string;
  /** `<noscript>` block carrying a title + excerpt for non-JS clients. */
  noscriptBody: string;
  /** `<link rel="alternate">` pointing at the raw-text variant, or '' when disabled. */
  alternateLink: string;
}

export function prepareShareMeta(input: ShareMetaInput): ShareMetaOutput {
  const titleEsc = escapeHtml(input.title);

  const descSource = input.description?.trim() || stripToText(input.bodyForExcerpt ?? '', MAX_DESCRIPTION_LEN);
  const descText =
    descSource.length > MAX_DESCRIPTION_LEN
      ? descSource.slice(0, MAX_DESCRIPTION_LEN - 3).trimEnd() + '...'
      : descSource;
  const descEsc = descText ? escapeHtml(descText) : '';

  const excerptText = stripToText(input.bodyForExcerpt ?? '', MAX_EXCERPT_LEN) || descText;
  const excerptEsc = excerptText ? escapeHtml(excerptText) : '';

  const canonicalEsc = escapeHtml(input.canonicalUrl);
  const rawEsc = input.rawUrl ? escapeHtml(input.rawUrl) : '';
  const siteEsc = input.siteName ? escapeHtml(input.siteName) : '';

  // Unfurl CTA: shared links are the product's lead-gen surface (chat clients
  // render og:/twitter:description in the link card), so append a short
  // brand-derived call to action there. The plain `meta name="description"`
  // stays CTA-free — that one feeds search snippets, not link cards.
  const ctaText = input.siteName ? `Build and share with ${input.siteName}.` : '';
  const unfurlDesc = descText ? (ctaText ? `${descText} · ${ctaText}` : descText) : ctaText;
  const unfurlDescEsc = unfurlDesc ? escapeHtml(unfurlDesc) : '';

  const metaTags = [
    descEsc ? `<meta name="description" content="${descEsc}">` : '',
    `<meta property="og:title" content="${titleEsc}">`,
    unfurlDescEsc ? `<meta property="og:description" content="${unfurlDescEsc}">` : '',
    `<meta property="og:type" content="article">`,
    `<meta property="og:url" content="${canonicalEsc}">`,
    siteEsc ? `<meta property="og:site_name" content="${siteEsc}">` : '',
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${titleEsc}">`,
    unfurlDescEsc ? `<meta name="twitter:description" content="${unfurlDescEsc}">` : '',
    `<link rel="canonical" href="${canonicalEsc}">`,
  ]
    .filter(Boolean)
    .join('\n');

  const alternateLink = rawEsc
    ? `<link rel="alternate" type="text/plain" href="${rawEsc}" title="Plain text (agent-friendly)">`
    : '';

  const rawLinkHtml = rawEsc ? `<p><a href="${rawEsc}">View as plain text</a></p>` : '';
  const excerptHtml = excerptEsc ? `<p>${excerptEsc}</p>` : '';
  const noscriptBody = `<noscript><article class="b4m-share-noscript"><h1>${titleEsc}</h1>${excerptHtml}${rawLinkHtml}</article></noscript>`;

  return { metaTags, noscriptBody, alternateLink };
}
