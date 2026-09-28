import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';
import { cleanPageTitle, readPageTitle } from './pageTitle';

const EN_DASH = String.fromCharCode(0x2013);

describe('cleanPageTitle', () => {
  it('drops a pipe-delimited site suffix', () => {
    expect(cleanPageTitle('How tides work | Ocean Weekly')).toBe('How tides work');
  });

  it('drops only the last segment of a multi-part title', () => {
    expect(cleanPageTitle('How tides work | Science | Ocean Weekly')).toBe('How tides work | Science');
  });

  it('drops a dash suffix that matches the declared site name', () => {
    expect(cleanPageTitle(`How tides work ${EN_DASH} Ocean Weekly`, { siteName: 'Ocean Weekly' })).toBe(
      'How tides work'
    );
  });

  it('drops a dash suffix that matches the host', () => {
    expect(cleanPageTitle('How tides work - Ocean Weekly', { url: 'https://www.oceanweekly.example/tides' })).toBe(
      'How tides work'
    );
  });

  it('keeps the article half of a brand-first pipe title', () => {
    expect(cleanPageTitle('Acme Blog | How we scaled Postgres to a billion rows')).toBe(
      'Acme Blog | How we scaled Postgres to a billion rows'
    );
  });

  it('drops a long pipe suffix when it matches the host', () => {
    expect(cleanPageTitle('Tides | Ocean Weekly Magazine', { url: 'https://oceanweeklymagazine.example/t' })).toBe(
      'Tides'
    );
  });

  it('keeps a dash that is part of the title itself', () => {
    expect(cleanPageTitle('Rust - A Practical Guide', { url: 'https://blog.example.org/rust' })).toBe(
      'Rust - A Practical Guide'
    );
  });

  it('keeps a hyphenated word and collapses whitespace', () => {
    expect(cleanPageTitle('  Long-term\n  storage   ')).toBe('Long-term storage');
  });

  it('keeps the title whole when stripping would leave almost nothing', () => {
    expect(cleanPageTitle('Go | The Go Programming Language')).toBe('Go | The Go Programming Language');
  });
});

describe('readPageTitle', () => {
  it('ignores inline-SVG titles that cheerio would otherwise concatenate onto the page title', () => {
    const $ = load(
      '<html><head><title>How tides work | Ocean Weekly</title></head><body>' +
        '<button><svg><title>Close banner</title></svg></button>' +
        '<button><svg><title>Close banner</title></svg></button>' +
        '</body></html>'
    );

    expect(readPageTitle($, 'https://oceanweekly.example/tides')).toBe('How tides work');
  });

  it('uses og:site_name to recognise the suffix', () => {
    const $ = load(
      `<html><head><title>How tides work ${EN_DASH} Ocean Weekly</title>` +
        '<meta property="og:site_name" content="Ocean Weekly"></head><body></body></html>'
    );

    expect(readPageTitle($, 'https://news.example/tides')).toBe('How tides work');
  });

  it('returns an empty string for a page whose only titles are SVG icon labels', () => {
    const $ = load('<html><body><svg><title>Close banner</title></svg><p>text</p></body></html>');

    expect(readPageTitle($, 'https://news.example/tides')).toBe('');
  });
});
