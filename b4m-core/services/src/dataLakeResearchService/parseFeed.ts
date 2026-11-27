import type { Cheerio, CheerioAPI } from 'cheerio';
import { load } from 'cheerio';
import { RESEARCH_FEED_MAX_ITEMS, RESEARCH_FEED_SNIPPET_MAX_CHARS } from '@bike4mind/common';

/** One feed entry. Structurally a `ResearchCandidate`, so selection hands items straight to the loop. */
export interface FeedItem {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: Date;
  authors?: string[];
  categories?: string[];
}

type FeedNode = Parameters<CheerioAPI['contains']>[0];

const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim();

/**
 * Feed text fields carry escaped or CDATA-wrapped HTML, which an XML-mode `.text()` returns as
 * literal markup. A second, HTML-mode parse turns it into plain text.
 */
const htmlToText = (value: string): string => {
  const $ = load(value, null, false);
  $('script, style').remove();
  return collapse($.root().text());
};

const httpUrl = (value: string | undefined, baseUrl: string): string | null => {
  if (!value || !value.trim()) return null;
  try {
    const resolved = new URL(value.trim(), baseUrl);
    return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.toString() : null;
  } catch {
    return null;
  }
};

const parseDate = (value: string | undefined): Date | undefined => {
  if (!value || !value.trim()) return undefined;
  const ms = Date.parse(value.trim());
  return Number.isNaN(ms) ? undefined : new Date(ms);
};

const unique = (values: string[]): string[] | undefined => {
  const out = Array.from(new Set(values.map(collapse).filter(Boolean)));
  return out.length > 0 ? out : undefined;
};

const HTML_LINK_TYPES = new Set(['', 'text/html', 'application/xhtml+xml']);

/**
 * Returns the items of an RSS 2.0, RSS 1.0 or Atom document, or null when the root is none of
 * those (an HTML page served in place of a feed, for one). Items with no http(s) URL are dropped;
 * an unparseable date reads as undated.
 */
export function parseFeed(xml: string, baseUrl: string): FeedItem[] | null {
  const $ = load(xml, { xml: true });
  const rootName = ($.root().children().first().get(0) as { name?: string } | undefined)?.name?.toLowerCase();
  const isAtom = rootName === 'feed';
  if (!isAtom && rootName !== 'rss' && rootName !== 'rdf:rdf') return null;

  const child = (el: FeedNode, selector: string): Cheerio<FeedNode> => $(el).children(selector);
  const text = (el: FeedNode, selector: string): string | undefined => {
    const found = child(el, selector).first();
    return found.length > 0 ? found.text() : undefined;
  };
  const texts = (el: FeedNode, selector: string): string[] =>
    child(el, selector)
      .toArray()
      .map(node => $(node).text());

  const atomUrl = (entry: FeedNode): string | null => {
    const links = child(entry, 'link')
      .toArray()
      .map(node => ({
        href: $(node).attr('href'),
        rel: ($(node).attr('rel') ?? 'alternate').toLowerCase(),
        type: ($(node).attr('type') ?? '').toLowerCase(),
      }));
    const pick = (match: (link: (typeof links)[number]) => boolean) => {
      for (const link of links.filter(match)) {
        const resolved = httpUrl(link.href, baseUrl);
        if (resolved) return resolved;
      }
      return null;
    };
    return (
      pick(link => link.rel === 'alternate' && HTML_LINK_TYPES.has(link.type)) ??
      pick(link => link.type === 'application/pdf') ??
      pick(link => link.rel === 'alternate')
    );
  };

  const rssUrl = (item: FeedNode): string | null => {
    const fromLink = httpUrl(text(item, 'link'), baseUrl);
    if (fromLink) return fromLink;
    const guid = child(item, 'guid').first();
    if (guid.length === 0 || guid.attr('isPermaLink')?.toLowerCase() === 'false') return null;
    const value = guid.text().trim();
    return /^https?:\/\//i.test(value) ? httpUrl(value, baseUrl) : null;
  };

  const items: FeedItem[] = [];
  for (const node of $(isAtom ? 'entry' : 'item').toArray()) {
    if (items.length >= RESEARCH_FEED_MAX_ITEMS) break;
    const url = isAtom ? atomUrl(node) : rssUrl(node);
    if (!url) continue;

    const rawTitle = collapse(text(node, 'title') ?? '');
    const title = (rawTitle.includes('<') ? htmlToText(rawTitle) : rawTitle) || url;

    let rawSnippet: string;
    let publishedAt: Date | undefined;
    let authors: string[] | undefined;
    let categories: string[] | undefined;
    if (isAtom) {
      const body =
        child(node, 'summary').first().length > 0 ? child(node, 'summary').first() : child(node, 'content').first();
      rawSnippet = body.text();
      if (body.attr('type')?.toLowerCase() === 'text') rawSnippet = rawSnippet.replace(/</g, '&lt;');
      publishedAt = parseDate(text(node, 'published')) ?? parseDate(text(node, 'updated'));
      authors = unique(
        child(node, 'author')
          .toArray()
          .map(a => text(a, 'name') ?? '')
      );
      categories = unique(
        child(node, 'category')
          .toArray()
          .map(c => $(c).attr('term') ?? $(c).attr('label') ?? '')
      );
    } else {
      rawSnippet = text(node, 'description') ?? '';
      publishedAt = parseDate(text(node, 'pubDate')) ?? parseDate(text(node, 'dc\\:date'));
      authors = unique([...texts(node, 'dc\\:creator'), ...texts(node, 'author')]);
      categories = unique([...texts(node, 'category'), ...texts(node, 'dc\\:subject')]);
    }

    items.push({
      title,
      url,
      snippet: htmlToText(rawSnippet).slice(0, RESEARCH_FEED_SNIPPET_MAX_CHARS),
      ...(publishedAt ? { publishedAt } : {}),
      ...(authors ? { authors } : {}),
      ...(categories ? { categories } : {}),
    });
  }
  return items;
}
