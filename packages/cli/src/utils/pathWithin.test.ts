import { describe, it, expect } from 'vitest';
import path from 'path';
import { isPathWithin } from './pathWithin.js';

describe('isPathWithin', () => {
  const root = path.join(path.sep, 'a', 'b');

  it('accepts the root itself and a nested path', () => {
    expect(isPathWithin(root, root)).toBe(true);
    expect(isPathWithin(path.join(root, 'c', 'd.ts'), root)).toBe(true);
  });

  it('refuses a sibling and a prefix-sharing sibling', () => {
    expect(isPathWithin(path.join(path.sep, 'a', 'c'), root)).toBe(false);
    // Prefix match without a separator boundary must not count as containment.
    expect(isPathWithin(root + '-sibling', root)).toBe(false);
  });

  it('handles a `/` root without producing a `//` prefix that refuses everything', () => {
    const slash = path.sep;
    expect(isPathWithin(slash, slash)).toBe(true);
    expect(isPathWithin(path.join(slash, 'anything'), slash)).toBe(true);
  });
});
