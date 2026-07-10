import { describe, it, expect } from 'vitest';
import { prepareShareMeta, stripToText } from './prepareShareMeta';

describe('stripToText', () => {
  it('drops script/style contents rather than surfacing them as excerpt text', () => {
    const html =
      '<html><head><style>.a{color:red}</style></head><body><script>evil()</script><p>Hello world</p></body></html>';
    expect(stripToText(html, 500)).toBe('Hello world');
  });

  it('decodes common entities and collapses whitespace', () => {
    const html = '<p>Tom&nbsp;&amp;   Jerry\n\n\n&lt;live&gt;</p>';
    expect(stripToText(html, 500)).toBe('Tom & Jerry <live>');
  });

  it('truncates with an ellipsis when longer than max', () => {
    const html = '<p>' + 'a'.repeat(100) + '</p>';
    const out = stripToText(html, 20);
    expect(out.endsWith('...')).toBe(true);
    expect(out.length).toBe(20);
  });

  it('returns empty for empty input', () => {
    expect(stripToText('', 500)).toBe('');
  });
});

describe('prepareShareMeta', () => {
  it('emits og:*, twitter:*, description, and canonical for a public share', () => {
    const { metaTags } = prepareShareMeta({
      title: 'Hello',
      description: 'A short description',
      canonicalUrl: 'https://example.com/p/u/scope/slug',
      rawUrl: 'https://example.com/p/u/scope/slug?format=raw',
      siteName: 'ExampleApp',
    });

    expect(metaTags).toContain('<meta name="description" content="A short description">');
    expect(metaTags).toContain('<meta property="og:title" content="Hello">');
    expect(metaTags).toContain('<meta property="og:description" content="A short description">');
    expect(metaTags).toContain('<meta property="og:type" content="article">');
    expect(metaTags).toContain('<meta property="og:url" content="https://example.com/p/u/scope/slug">');
    expect(metaTags).toContain('<meta property="og:site_name" content="ExampleApp">');
    expect(metaTags).toContain('<meta name="twitter:card" content="summary">');
    expect(metaTags).toContain('<meta name="twitter:title" content="Hello">');
    expect(metaTags).toContain('<meta name="twitter:description" content="A short description">');
    expect(metaTags).toContain('<link rel="canonical" href="https://example.com/p/u/scope/slug">');
  });

  it('escapes title/description/URL to prevent breakout in meta attributes', () => {
    const { metaTags, noscriptBody } = prepareShareMeta({
      title: 'Tom & Jerry "<script>alert(1)</script>"',
      description: 'A "risky" & <bad> desc',
      canonicalUrl: 'https://example.com/p/u/scope/slug?x="y"',
    });
    expect(metaTags).not.toContain('<script>alert');
    expect(metaTags).toContain('Tom &amp; Jerry &quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot;');
    expect(metaTags).toContain('A &quot;risky&quot; &amp; &lt;bad&gt; desc');
    expect(metaTags).toContain('x=&quot;y&quot;');
    expect(noscriptBody).toContain('Tom &amp; Jerry &quot;&lt;script&gt;');
    expect(noscriptBody).not.toContain('<script>');
  });

  it('derives the description from the body excerpt when no description is provided', () => {
    const { metaTags } = prepareShareMeta({
      title: 'Hello',
      bodyForExcerpt: '<html><body><p>This body text should become the description fallback.</p></body></html>',
      canonicalUrl: 'https://example.com/p/u/scope/slug',
    });
    expect(metaTags).toContain('This body text should become the description fallback.');
  });

  it('omits description meta when neither description nor excerpt is available', () => {
    const { metaTags } = prepareShareMeta({
      title: 'Hello',
      canonicalUrl: 'https://example.com/p/u/scope/slug',
    });
    expect(metaTags).not.toContain('<meta name="description"');
    expect(metaTags).not.toContain('<meta property="og:description"');
    expect(metaTags).not.toContain('<meta name="twitter:description"');
    // Title / og:type / canonical still emit unconditionally.
    expect(metaTags).toContain('<meta property="og:title" content="Hello">');
    expect(metaTags).toContain('<meta property="og:type" content="article">');
  });

  it('emits a <link rel="alternate"> only when a raw URL is provided', () => {
    const with_raw = prepareShareMeta({
      title: 'Hello',
      canonicalUrl: 'https://example.com/p/u/scope/slug',
      rawUrl: 'https://example.com/p/u/scope/slug?format=raw',
    });
    expect(with_raw.alternateLink).toContain('rel="alternate"');
    expect(with_raw.alternateLink).toContain('type="text/plain"');
    expect(with_raw.alternateLink).toContain('href="https://example.com/p/u/scope/slug?format=raw"');

    const without_raw = prepareShareMeta({
      title: 'Hello',
      canonicalUrl: 'https://example.com/p/u/scope/slug',
    });
    expect(without_raw.alternateLink).toBe('');
  });

  it('noscript body carries the title and (when derivable) a plain-text excerpt', () => {
    const { noscriptBody } = prepareShareMeta({
      title: 'Hello',
      bodyForExcerpt: '<html><body><h1>Ignore</h1><p>Body text extracted for agents.</p></body></html>',
      canonicalUrl: 'https://example.com/p/u/scope/slug',
      rawUrl: 'https://example.com/p/u/scope/slug?format=raw',
    });
    expect(noscriptBody.startsWith('<noscript>')).toBe(true);
    expect(noscriptBody).toContain('<h1>Hello</h1>');
    expect(noscriptBody).toContain('Body text extracted for agents.');
    expect(noscriptBody).toContain('View as plain text');
    expect(noscriptBody).toContain('href="https://example.com/p/u/scope/slug?format=raw"');
  });

  it('omits the raw-link paragraph in the noscript when no rawUrl is provided', () => {
    const { noscriptBody } = prepareShareMeta({
      title: 'Hello',
      description: 'desc',
      canonicalUrl: 'https://example.com/p/u/scope/slug',
    });
    expect(noscriptBody).not.toContain('View as plain text');
  });
});
