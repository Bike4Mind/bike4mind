import type { CheerioAPI } from 'cheerio';

const SEPARATOR = / (\||-|\u2013|\u2014|\u00b7|\u2022|::) /g;

const letters = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** The registrable-domain label (e.g. "chromecity" for "www.chromecity.example"), not the full host. */
function domainLabel(url: string): string {
  try {
    const parts = new URL(url).hostname.replace(/^www\./, '').split('.');
    return letters(parts.length > 1 ? parts[parts.length - 2] : parts[0]);
  } catch {
    return '';
  }
}

/**
 * Whether `suffix` names the site rather than the document: it matches the declared site name or
 * the domain label exactly. A substring match ("chromecity" contains "rome") or a bare
 * length heuristic both misfire on real titles ("How to deploy | Part 2", "Visiting Rome - Rome"),
 * so a suffix is dropped only when it can be positively identified as the site.
 */
function isSiteSuffix(suffix: string, siteName: string, url: string): boolean {
  const normalized = letters(suffix);
  if (normalized.length < 3) return false;
  if (siteName && letters(siteName) === normalized) return true;
  return domainLabel(url) === normalized;
}

/** Collapse whitespace and drop a trailing site-name segment ("Article | Site" -> "Article"). */
export function cleanPageTitle(raw: string, { siteName = '', url = '' }: { siteName?: string; url?: string } = {}) {
  const title = raw.replace(/\s+/g, ' ').trim();
  const last = [...title.matchAll(SEPARATOR)].pop();
  if (last?.index === undefined) return title;
  const head = title.slice(0, last.index).trim();
  const suffix = title.slice(last.index + last[0].length).trim();
  return head.length >= 3 && isSiteSuffix(suffix, siteName.trim(), url) ? head : title;
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
