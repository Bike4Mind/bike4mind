import { describe, it, expect } from 'vitest';
import { isStaticAssetPath } from './isStaticAssetPath';

describe('isStaticAssetPath', () => {
  it('matches a final segment ending in a static-asset extension', () => {
    expect(isStaticAssetPath(['pdf.worker-0.0.0.min.mjs'])).toBe(true);
    expect(isStaticAssetPath(['x.js'])).toBe(true);
    expect(isStaticAssetPath(['a', 'b.wasm'])).toBe(true);
    expect(isStaticAssetPath(['X.PNG'])).toBe(true);
    expect(isStaticAssetPath(['nope.json'])).toBe(true);
    expect(isStaticAssetPath(['nope.css'])).toBe(true);
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

  it('exempts the QA test deep link, whose segment is an arbitrary key', () => {
    expect(isStaticAssetPath(['status', 'tests', 'notebook.spec.ts > saves.json'])).toBe(false);
  });
});
