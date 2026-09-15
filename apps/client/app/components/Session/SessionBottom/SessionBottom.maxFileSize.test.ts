import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Regression guard (#2456): `useGetSettingsValue('MaxFileSize') || 30` doesn't coerce
// first, so a stored '0' string (truthy) survives the `||` unchanged and reproduces the
// zero-cap upload bug. A source-level assertion is used here (not a render test) because
// SessionBottom requires a large web of context providers that adds little signal beyond
// locking this invariant - see SessionBottom.dedup.test.ts for the same tradeoff.
describe('SessionBottom - MaxFileSize coerces before falling back (regression)', () => {
  const sessionBottom = readFileSync(resolve(__dirname, 'SessionBottom.tsx'), 'utf8');

  it("wraps useGetSettingsValue('MaxFileSize') in Number(...) before the || fallback", () => {
    expect(sessionBottom).toMatch(/const maxFileSize = Number\(useGetSettingsValue\('MaxFileSize'\)\) \|\| 30;/);
  });
});
