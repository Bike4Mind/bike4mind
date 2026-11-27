import { escapeHtml } from '@bike4mind/server-utils/services/publish/viewerSecurity';

/**
 * Build the server-rendered head-meta and noscript body a public share needs to
 * be legible to agents (unfurlers, LLM URL fetchers, non-JS crawlers). Callers
 * pass raw text/HTML; escaping happens here at the point of interpolation, so
 * the returned strings are safe to splice directly into a wrapper page.
 *
 * Applies to public shares only. Gated bundles must NOT emit meta/noscript that
 * leak artifact content pre-auth - the loader shell stays deliberately blank.
 * `/a/<token>` links use the narrower {@link prepareShareTokenMeta} instead.
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

/** The unfurl card image. Never an owner-only artifact thumbnail: those are private renders. */
export interface ShareImage {
  /** Absolute https URL. */
  url: string;
  alt?: string;
}

/**
 * The deploy's default unfurl image (`PUBLISH_SHARE_IMAGE_URL`, ideally 1200x630), or
 * undefined when unset or not an absolute https URL - forks ship no image, not a broken one.
 */
export function defaultShareImage(siteName?: string): ShareImage | undefined {
  const raw = process.env.PUBLISH_SHARE_IMAGE_URL?.trim();
  if (!raw) return undefined;
  try {
    if (new URL(raw).protocol !== 'https:') return undefined;
  } catch {
    return undefined;
  }
  return { url: raw, alt: siteName || undefined };
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
  image?: ShareImage;
}

export interface ShareMetaOutput {
  /** `<meta>` + `<link rel="canonical">` head block (newline-joined). */
  metaTags: string;
  /** `<noscript>` block carrying a title + excerpt for non-JS clients. */
  noscriptBody: string;
  /** `<link rel="alternate">` pointing at the raw-text variant, or '' when disabled. */
  alternateLink: string;
}

interface UnfurlInput {
  title: string;
  /** Plain text, already trimmed to MAX_DESCRIPTION_LEN. */
  description: string;
  siteName?: string;
  image?: ShareImage;
  /** og:url; omitted when empty. */
  url?: string;
}

/** The description/og:/twitter: tags shared by public pages and share-token links. */
function buildUnfurlTags(input: UnfurlInput): string[] {
  const titleEsc = escapeHtml(input.title);
  const descEsc = input.description ? escapeHtml(input.description) : '';
  const siteEsc = input.siteName ? escapeHtml(input.siteName) : '';

  // Unfurl CTA: shared links are the product's lead-gen surface (chat clients
  // render og:/twitter:description in the link card), so append a short
  // brand-derived call to action there. The plain `meta name="description"`
  // stays CTA-free - that one feeds search snippets, not link cards.
  const ctaText = input.siteName ? `Build and share with ${input.siteName}.` : '';
  const unfurlDesc = input.description ? (ctaText ? `${input.description} - ${ctaText}` : input.description) : ctaText;
  const unfurlDescEsc = unfurlDesc ? escapeHtml(unfurlDesc) : '';

  const imageEsc = input.image ? escapeHtml(input.image.url) : '';
  const imageAltEsc = input.image?.alt ? escapeHtml(input.image.alt) : '';

  return [
    descEsc ? `<meta name="description" content="${descEsc}">` : '',
    `<meta property="og:title" content="${titleEsc}">`,
    unfurlDescEsc ? `<meta property="og:description" content="${unfurlDescEsc}">` : '',
    `<meta property="og:type" content="article">`,
    input.url ? `<meta property="og:url" content="${escapeHtml(input.url)}">` : '',
    siteEsc ? `<meta property="og:site_name" content="${siteEsc}">` : '',
    imageEsc ? `<meta property="og:image" content="${imageEsc}">` : '',
    imageAltEsc ? `<meta property="og:image:alt" content="${imageAltEsc}">` : '',
    `<meta name="twitter:card" content="${imageEsc ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${titleEsc}">`,
    unfurlDescEsc ? `<meta name="twitter:description" content="${unfurlDescEsc}">` : '',
    imageEsc ? `<meta name="twitter:image" content="${imageEsc}">` : '',
    imageAltEsc ? `<meta name="twitter:image:alt" content="${imageAltEsc}">` : '',
  ];
}

function clampDescription(text: string): string {
  return text.length > MAX_DESCRIPTION_LEN ? text.slice(0, MAX_DESCRIPTION_LEN - 3).trimEnd() + '...' : text;
}

export function prepareShareMeta(input: ShareMetaInput): ShareMetaOutput {
  const titleEsc = escapeHtml(input.title);

  const descText = clampDescription(
    input.description?.trim() || stripToText(input.bodyForExcerpt ?? '', MAX_DESCRIPTION_LEN)
  );

  const excerptText = stripToText(input.bodyForExcerpt ?? '', MAX_EXCERPT_LEN) || descText;
  const excerptEsc = excerptText ? escapeHtml(excerptText) : '';

  const canonicalEsc = escapeHtml(input.canonicalUrl);
  const rawEsc = input.rawUrl ? escapeHtml(input.rawUrl) : '';

  const metaTags = [
    ...buildUnfurlTags({
      title: input.title,
      description: descText,
      siteName: input.siteName,
      image: input.image,
      url: input.canonicalUrl,
    }),
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

export interface ShareTokenMetaInput {
  title: string;
  /** Author-supplied description only - never text derived from the artifact body. */
  description?: string;
  siteName?: string;
  image?: ShareImage;
}

/**
 * The link card for an ungated `/a/<token>` link. The token is a private capability, and
 * an unfurler caches whatever the card says, so the card carries only what the author
 * chose to put on it (title, description, image): no body-derived description, noscript
 * excerpt, canonical or plain-text alternate, and no og:url (it would repeat the token).
 */
export function prepareShareTokenMeta(input: ShareTokenMetaInput): ShareMetaOutput {
  const metaTags = buildUnfurlTags({
    title: input.title,
    description: clampDescription(input.description?.trim() ?? ''),
    siteName: input.siteName,
    image: input.image,
  })
    .filter(Boolean)
    .join('\n');
  return { metaTags, noscriptBody: '', alternateLink: '' };
}
