import { describe, it, expect } from 'vitest';
import { slugifyDataLakeName, isValidDataLakeSlug } from './dataLakeSlug';

// The server validates the slug with slug.min(2) AND slugRegex
// (/^[a-z0-9][a-z0-9-]*[a-z0-9]$/). isValidDataLakeSlug is the client gate that
// must agree with both, so a name never passes here only to be rejected server-side.
const slugRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

describe('slugifyDataLakeName', () => {
  it('lowercases and hyphenates runs of non-alphanumerics', () => {
    expect(slugifyDataLakeName('Legal Contracts KB')).toBe('legal-contracts-kb');
  });

  it('strips leading and trailing hyphens', () => {
    expect(slugifyDataLakeName('  ...Hello!!  ')).toBe('hello');
  });

  it('yields an empty string when nothing alphanumeric remains', () => {
    expect(slugifyDataLakeName('!!')).toBe('');
  });

  it('never leaves a trailing hyphen when truncation lands mid-word', () => {
    // 59 letters + a space would put the collapsed hyphen at index 59; a naive
    // trim-then-slice would keep it, producing a slug the server's slugRegex rejects.
    const slug = slugifyDataLakeName('x'.repeat(59) + ' extra');
    expect(slug).toBe('x'.repeat(59));
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug).toMatch(slugRegex);
  });
});

describe('isValidDataLakeSlug', () => {
  it('rejects a name that slugifies below the 2-char minimum', () => {
    expect(isValidDataLakeSlug('!!')).toBe(false);
    expect(isValidDataLakeSlug('a')).toBe(false);
  });

  it('accepts a name that yields a server-valid slug', () => {
    expect(isValidDataLakeSlug('Legal Contracts')).toBe(true);
  });

  it('only returns true for slugs the server slugRegex also accepts', () => {
    for (const name of ['ab', 'Legal Contracts', 'x'.repeat(59) + ' extra', 'A-B']) {
      if (isValidDataLakeSlug(name)) {
        expect(slugifyDataLakeName(name)).toMatch(slugRegex);
      }
    }
  });
});
