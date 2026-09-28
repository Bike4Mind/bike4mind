import type { CheerioAPI } from 'cheerio';

const SEPARATOR = / (\||-|\u2013|\u2014|\u00b7|\u2022|::) /g;

const letters = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function hostLabel(url: string): string {
  try {
    return letters(new URL(url).hostname.replace(/^www\./, ''));
  } catch {
    return '';
  }
}

/**
 * Whether `suffix` names the site rather than the document: it matches the declared site name or
 * the host. A pipe suffix is also dropped when it is shorter than what precedes it - pipes almost
 * always delimit the site, but a brand-first title ("Acme Blog | How we scaled") must keep its
 * article half. A dash is common INSIDE real titles ("Rust - A Guide"), so it gets no such leeway.
 */
function isSiteSuffix(separator: string, head: string, suffix: string, siteName: string, url: string): boolean {
  const normalized = letters(suffix);
  if (normalized.length >= 3) {
    if (siteName && letters(siteName) === normalized) return true;
    if (hostLabel(url).includes(normalized)) return true;
  }
  return separator === '|' && suffix.length < head.length;
}

/** Collapse whitespace and drop a trailing site-name segment ("Article | Site" -> "Article"). */
export function cleanPageTitle(raw: string, { siteName = '', url = '' }: { siteName?: string; url?: string } = {}) {
  const title = raw.replace(/\s+/g, ' ').trim();
  const last = [...title.matchAll(SEPARATOR)].pop();
  if (last?.index === undefined) return title;
  const head = title.slice(0, last.index).trim();
  const suffix = title.slice(last.index + last[0].length).trim();
  return head.length >= 3 && isSiteSuffix(last[1], head, suffix, siteName.trim(), url) ? head : title;
}

/**
 * The document's own title. `$('title')` alone also matches every inline-SVG `<title>` in the body
 * (icon labels such as "Close banner"), and `.text()` concatenates them onto the real one.
 */
export function readPageTitle($: CheerioAPI, url: string): string {
  const headTitle = $('head > title').first().text();
  const raw =
    headTitle ||
    $('title')
      .filter((_index, element) => $(element).closest('svg').length === 0)
      .first()
      .text();
  const siteName = $('meta[property="og:site_name"]').attr('content') ?? '';
  return cleanPageTitle(raw, { siteName, url });
}
