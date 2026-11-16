import { describe, it, expect } from 'vitest';
import { RESEARCH_FEED_MAX_ITEMS, RESEARCH_FEED_SNIPPET_MAX_CHARS } from '@bike4mind/common';
import { parseFeed } from './parseFeed';

const BASE = 'https://feeds.example.org/path/feed.xml';

const RSS2 = `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Feed</title>
    <link>https://example.org/</link>
    <item>
      <title>First paper</title>
      <link>https://example.org/a</link>
      <description><![CDATA[<p>Hello <b>world</b></p>]]></description>
      <pubDate>Tue, 10 Nov 2026 10:00:00 GMT</pubDate>
      <author>editor@example.org (Ed)</author>
      <category>physics</category>
      <category>optics</category>
    </item>
    <item>
      <title>Second</title>
      <link>https://example.org/b</link>
      <description>Escaped &lt;i&gt;markup&lt;/i&gt; and   spacing</description>
    </item>
  </channel>
</rss>`;

const RSS1 = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://example.org/"><title>Feed</title></channel>
  <item rdf:about="https://example.org/r1">
    <title>RDF item</title>
    <link>https://example.org/r1</link>
    <description>Desc</description>
    <dc:creator>Ada Lovelace</dc:creator>
    <dc:creator>Grace Hopper</dc:creator>
    <dc:date>2026-11-09T08:30:00Z</dc:date>
    <dc:subject>computing</dc:subject>
  </item>
</rdf:RDF>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom feed</title>
  <entry>
    <title>Atom one</title>
    <id>urn:uuid:1</id>
    <link rel="alternate" type="application/pdf" href="https://example.org/one.pdf"/>
    <link rel="alternate" type="text/html" href="https://example.org/one"/>
    <summary type="html">&lt;p&gt;Summary &amp;amp; more&lt;/p&gt;</summary>
    <published>2026-11-01T00:00:00Z</published>
    <updated>2026-11-05T00:00:00Z</updated>
    <author><name>Alan Turing</name></author>
    <category term="math"/>
    <category term="logic" label="Logic"/>
  </entry>
  <entry>
    <title>Atom two</title>
    <id>https://example.org/should-not-be-used</id>
    <link rel="alternate" type="application/pdf" href="/two.pdf"/>
    <content type="text">plain &amp; simple</content>
    <updated>2026-11-06T00:00:00Z</updated>
  </entry>
  <entry>
    <title>No link</title>
    <id>https://example.org/id-only</id>
  </entry>
  <entry>
    <title>Self only</title>
    <link rel="self" href="https://example.org/self"/>
  </entry>
</feed>`;

describe('parseFeed', () => {
  it('parses RSS 2.0 with CDATA and escaped HTML descriptions as plain text', () => {
    const items = parseFeed(RSS2, BASE)!;
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: 'First paper',
      url: 'https://example.org/a',
      snippet: 'Hello world',
      publishedAt: new Date('2026-11-10T10:00:00Z'),
      authors: ['editor@example.org (Ed)'],
      categories: ['physics', 'optics'],
    });
    expect(items[1].snippet).toBe('Escaped markup and spacing');
    expect(items[1].publishedAt).toBeUndefined();
    expect(items[1].authors).toBeUndefined();
  });

  it('parses RSS 1.0 and reads namespaced dc:creator and dc:date', () => {
    const items = parseFeed(RSS1, BASE)!;
    expect(items).toEqual([
      {
        title: 'RDF item',
        url: 'https://example.org/r1',
        snippet: 'Desc',
        publishedAt: new Date('2026-11-09T08:30:00Z'),
        authors: ['Ada Lovelace', 'Grace Hopper'],
        categories: ['computing'],
      },
    ]);
  });

  it('parses Atom: prefers the html link, falls back to pdf, never uses id, drops linkless entries', () => {
    const items = parseFeed(ATOM, BASE)!;
    expect(items.map(i => i.url)).toEqual(['https://example.org/one', 'https://feeds.example.org/two.pdf']);
    expect(items[0]).toMatchObject({
      snippet: 'Summary & more',
      publishedAt: new Date('2026-11-01T00:00:00Z'),
      authors: ['Alan Turing'],
      categories: ['math', 'logic'],
    });
    expect(items[1].publishedAt).toEqual(new Date('2026-11-06T00:00:00Z'));
    expect(items[1].snippet).toBe('plain & simple');
  });

  it('resolves relative item links against the base url', () => {
    const xml = `<rss><channel><item><title>t</title><link>../rel/x</link></item></channel></rss>`;
    expect(parseFeed(xml, BASE)![0].url).toBe('https://feeds.example.org/rel/x');
  });

  it.each([
    ['a guid that is a permalink', '<guid>https://example.org/g</guid>', 'https://example.org/g'],
    ['a guid with isPermaLink="false"', '<guid isPermaLink="false">https://example.org/g</guid>', undefined],
    ['a guid that is not a url', '<guid>abc-123</guid>', undefined],
  ])('falls back to guid for %s', (_name, guid, expected) => {
    const items = parseFeed(`<rss><channel><item><title>t</title>${guid}</item></channel></rss>`, BASE)!;
    expect(items[0]?.url).toBe(expected);
  });

  it('drops non-http(s) links', () => {
    const xml = `<rss><channel><item><title>t</title><link>ftp://example.org/x</link></item></channel></rss>`;
    expect(parseFeed(xml, BASE)).toEqual([]);
  });

  it('reads an unparseable date as undated', () => {
    const xml = `<rss><channel><item><title>t</title><link>https://e.org/x</link><pubDate>yesterday-ish</pubDate></item></channel></rss>`;
    expect(parseFeed(xml, BASE)![0].publishedAt).toBeUndefined();
  });

  it('caps the snippet', () => {
    const xml = `<rss><channel><item><title>t</title><link>https://e.org/x</link><description>${'a'.repeat(5000)}</description></item></channel></rss>`;
    expect(parseFeed(xml, BASE)![0].snippet).toHaveLength(RESEARCH_FEED_SNIPPET_MAX_CHARS);
  });

  it('keeps an item with no description and an empty snippet', () => {
    const xml = `<rss><channel><item><title>t</title><link>https://e.org/x</link></item></channel></rss>`;
    expect(parseFeed(xml, BASE)![0].snippet).toBe('');
  });

  it('stops at the item cap', () => {
    const many = Array.from(
      { length: RESEARCH_FEED_MAX_ITEMS + 25 },
      (_, i) => `<item><title>t${i}</title><link>https://e.org/${i}</link></item>`
    ).join('');
    expect(parseFeed(`<rss><channel>${many}</channel></rss>`, BASE)).toHaveLength(RESEARCH_FEED_MAX_ITEMS);
  });

  it('returns null for an HTML page and for text that is not XML', () => {
    expect(parseFeed('<!doctype html><html><body><h1>Hi</h1></body></html>', BASE)).toBeNull();
    expect(parseFeed('<html><head></head><body></body></html>', BASE)).toBeNull();
    expect(parseFeed('this is not xml at all', BASE)).toBeNull();
    expect(parseFeed('', BASE)).toBeNull();
  });

  it('keeps the items read before a truncated document ends', () => {
    const xml = `<rss><channel><item><title>a</title><link>https://e.org/a</link></item><item><title>b</title><link>https://e.org/b`;
    const items = parseFeed(xml, BASE);
    expect(items?.[0].url).toBe('https://e.org/a');
  });
});
