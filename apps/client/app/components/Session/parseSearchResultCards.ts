/**
 * Parser for the `b4m_cards` fence the model emits inline in a reply to illustrate a visual answer.
 *
 * The fence format and field names must stay in sync with WEB_SEARCH_CARDS_PROMPT in
 * b4m-core/services/src/llm/prompts/index.ts, which is what teaches the model to write it.
 *
 * Everything here runs against a STREAMING fence: the renderer re-parses on every token, so a block
 * that is still half-written is the normal case, not an error. Hence the three-state return - the
 * caller shows a skeleton for 'pending' and nothing at all for 'invalid', and never raw JSON.
 */

export { SEARCH_RESULT_CARDS_LANGUAGE } from '@bike4mind/common';

/** One image tile: the picture plus the hostname of the result it came from, for attribution. */
export interface SearchResultCardImage {
  url: string;
  source?: string;
}

export interface SearchResultCard {
  name: string;
  note?: string;
  /** Short footer line - a price, a key spec. */
  meta?: string;
  url?: string;
  images: SearchResultCardImage[];
}

export type ParsedSearchResultCards =
  { state: 'ok'; cards: SearchResultCard[] } | { state: 'pending' } | { state: 'invalid' };

// Bounds on what one fence may render, so a runaway generation cannot blow up the reply layout.
const MAX_CARDS = 8;
const MAX_IMAGES_PER_CARD = 4;

/**
 * Only absolute https URLs are rendered. http:// is mixed content, and data:/javascript: URIs in a
 * model-authored payload are an injection surface - the fence is untrusted text, not our own data.
 */
function safeImageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    return new URL(value).protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Link targets allow http as well - the card's own click-through is an ordinary external link. */
function safeLinkUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:' ? value : undefined;
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function parseImages(raw: unknown): SearchResultCardImage[] {
  if (!Array.isArray(raw)) return [];
  const images: SearchResultCardImage[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    // A bare string is accepted alongside the documented {url, source} object: models drop the
    // attribution wrapper often enough that rejecting it would lose otherwise good cards.
    const url = safeImageUrl(typeof entry === 'string' ? entry : (entry as { url?: unknown })?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    // Caption is ALWAYS the image's own derived hostname, never the model-authored `source` from
    // the fence: a hostile search snippet could otherwise caption a tile with a trusted-looking
    // host while the image/link point elsewhere. Also not the card's link host - a card linking
    // orientwatch.co whose picture is served from a jomashop CDN must not be captioned
    // "orientwatch.co".
    images.push({ url, source: hostnameOf(url) });
    if (images.length >= MAX_IMAGES_PER_CARD) break;
  }
  return images;
}

/**
 * Whether every bracket the text opened has been closed, ignoring those inside JSON strings. An
 * unclosed one means the generation is still in flight, which is how a half-streamed fence is told
 * apart from a finished-but-broken one.
 */
function isStructurallyClosed(text: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      // Over-closed: no further token can rescue this, so it is finished and broken, not pending.
      if (--depth < 0) return true;
    }
  }
  return !inString && depth === 0;
}

/**
 * A fence body is 'pending' while it could still become valid JSON with more tokens, and 'invalid'
 * once it is complete but unusable. The distinction is what stops a skeleton from hanging around
 * forever on a malformed block, and stops a valid block from flashing an error while it streams.
 */
export function parseSearchResultCards(content: string): ParsedSearchResultCards {
  const trimmed = content.trim();
  if (!trimmed) return { state: 'pending' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return isStructurallyClosed(trimmed) ? { state: 'invalid' } : { state: 'pending' };
  }

  if (typeof parsed !== 'object' || parsed === null) return { state: 'invalid' };
  const rawCards = (parsed as { cards?: unknown }).cards;
  if (!Array.isArray(rawCards)) return { state: 'invalid' };

  const cards: SearchResultCard[] = [];
  for (const entry of rawCards) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = nonEmptyString(record.name);
    if (!name) continue;
    const url = safeLinkUrl(record.url);
    const images = parseImages(record.images);
    if (images.length === 0) continue; // a card with no picture is what the text reply already does
    cards.push({
      name,
      note: nonEmptyString(record.note),
      meta: nonEmptyString(record.meta),
      url,
      images,
    });
    if (cards.length >= MAX_CARDS) break;
  }

  return cards.length > 0 ? { state: 'ok', cards } : { state: 'invalid' };
}
