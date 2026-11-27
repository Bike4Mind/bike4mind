import { describe, it, expect } from 'vitest';
import { isStaticAssetPath } from './isStaticAssetPath';

describe('isStaticAssetPath', () => {
  // One filename per alternation in the extension regex. Dropping any single alternation, or
  // narrowing `jpe?g` to `jpg` or `woff2?` to `woff`, fails this table.
  it.each([
    ['nope.js'],
    ['pdf.worker-0.0.0.min.mjs'],
    ['nope.cjs'],
    ['nope.wasm'],
    ['nope.json'],
    ['nope.css'],
    ['nope.js.map'],
    ['a.jpg'],
    ['a.jpeg'],
    ['nope.png'],
    ['a.gif'],
    ['a.svg'],
    ['a.webp'],
    ['a.avif'],
    ['favicon.ico'],
    ['a.woff'],
    ['a.woff2'],
    ['a.ttf'],
    ['a.otf'],
    ['a.eot'],
  ])('matches a final segment ending in a static-asset extension (%s)', segment => {
    expect(isStaticAssetPath([segment])).toBe(true);
    // Still matches when it is the last of several segments.
    expect(isStaticAssetPath(['assets', segment])).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isStaticAssetPath(['X.PNG'])).toBe(true);
    expect(isStaticAssetPath(['A.WOFF2'])).toBe(true);
  });

  it('requires a dot before the extension', () => {
    // A segment that merely ends in an extension token, with no dot, is a client route.
    expect(isStaticAssetPath(['roadmap'])).toBe(false);
    expect(isStaticAssetPath(['docs', 'sitemap'])).toBe(false);
    expect(isStaticAssetPath(['foo', 'barjs'])).toBe(false);
  });

  it('does not match client routes', () => {
    expect(isStaticAssetPath(undefined)).toBe(false);
    expect(isStaticAssetPath([])).toBe(false);
    expect(isStaticAssetPath(['notebooks', 'abc'])).toBe(false);
    // A dot in a non-final segment is still a route.
    expect(isStaticAssetPath(['v1.2', 'foo'])).toBe(false);
    // Near misses: the extension must be anchored at the end of the segment.
    expect(isStaticAssetPath(['file.jsonl'])).toBe(false);
    expect(isStaticAssetPath(['foo.jsx'])).toBe(false);
  });

  it.each([
    ['admin', 'qa', 'tests'],
    ['status', 'tests'],
  ])('exempts only the %s QA test deep link', (...prefix) => {
    // Its one dynamic segment is an arbitrary encoded QA key that can end in a file-like token.
    expect(isStaticAssetPath([...prefix, 'notebook.spec.ts > saves.json'])).toBe(false);
    expect(isStaticAssetPath([...prefix, 'x.json'])).toBe(false);
  });

  it('scopes the QA test exemption to its prefix', () => {
    // The exemption needs the full prefix: `/status/<file>` alone is still an asset path.
    expect(isStaticAssetPath(['status', 'x.json'])).toBe(true);
    expect(isStaticAssetPath(['admin', 'qa', 'x.json'])).toBe(true);
    expect(isStaticAssetPath(['foo', 'tests', 'x.json'])).toBe(true);
    expect(isStaticAssetPath(['admin', 'tests', 'x.json'])).toBe(true);
  });
});
