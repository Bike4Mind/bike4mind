import { describe, it, expect } from 'vitest';
import {
  DATA_LAKE_SLUG_REGEX,
  MAX_DATA_LAKE_SLUG_LENGTH,
  MAX_TAG_PREFIX_LENGTH,
  MIN_DATA_LAKE_SLUG_LENGTH,
} from '../constants/dataLakes';
import {
  slugifyDataLakeName,
  isValidDataLakeSlug,
  deriveTagPrefixFromLakeName,
  withTagPrefixSuffix,
} from './dataLakeSlug';

// The server validates the slug with MIN_DATA_LAKE_SLUG_LENGTH and DATA_LAKE_SLUG_REGEX;
// isValidDataLakeSlug is the client gate that must agree with both, so a name never passes
// here only to be rejected server-side. Asserting against the SHARED rule rather than a copy
// of it is the point: a copy would keep passing after the server rule moved.

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
    // trim-then-slice would keep it, producing a slug DATA_LAKE_SLUG_REGEX rejects.
    const slug = slugifyDataLakeName('x'.repeat(MAX_DATA_LAKE_SLUG_LENGTH - 1) + ' extra');
    expect(slug).toBe('x'.repeat(MAX_DATA_LAKE_SLUG_LENGTH - 1));
    expect(slug.length).toBeLessThanOrEqual(MAX_DATA_LAKE_SLUG_LENGTH);
    expect(slug).toMatch(DATA_LAKE_SLUG_REGEX);
  });
});

describe('isValidDataLakeSlug', () => {
  it('rejects a name that slugifies below the shared minimum', () => {
    expect(isValidDataLakeSlug('!!')).toBe(false);
    expect(isValidDataLakeSlug('a')).toBe(false);
  });

  it('accepts a name that yields a server-valid slug', () => {
    expect(isValidDataLakeSlug('Legal Contracts')).toBe(true);
  });

  it('only returns true for slugs the shared server pattern also accepts', () => {
    for (const name of ['ab', 'Legal Contracts', 'x'.repeat(MAX_DATA_LAKE_SLUG_LENGTH - 1) + ' extra', 'A-B']) {
      if (isValidDataLakeSlug(name)) {
        const slug = slugifyDataLakeName(name);
        expect(slug).toMatch(DATA_LAKE_SLUG_REGEX);
        expect(slug.length).toBeGreaterThanOrEqual(MIN_DATA_LAKE_SLUG_LENGTH);
        expect(slug.length).toBeLessThanOrEqual(MAX_DATA_LAKE_SLUG_LENGTH);
      }
    }
  });
});

describe('deriveTagPrefixFromLakeName', () => {
  it('derives the slug stem plus a colon', () => {
    expect(deriveTagPrefixFromLakeName('Legal Contracts')).toBe('legal-contracts:');
  });

  // Without the empty-stem guard this returns a bare ':' - all separator, no namespace - which
  // the store would then seed into the form. Latent today (the source step gates on
  // isValidDataLakeSlug, which such a name fails), so the guard is what keeps it latent.
  it('derives nothing at all from a name with no alphanumerics', () => {
    expect(deriveTagPrefixFromLakeName('!!!')).toBe('');
    expect(deriveTagPrefixFromLakeName('   ')).toBe('');
  });
});

describe('withTagPrefixSuffix', () => {
  it('keeps the base on attempt 0 and numbers later attempts from -1', () => {
    expect(withTagPrefixSuffix('acme:', 0)).toBe('acme:');
    expect(withTagPrefixSuffix('acme:', 1)).toBe('acme-1:');
    expect(withTagPrefixSuffix('docs:legal:', 1)).toBe('docs:legal-1:');
  });

  it('keeps fitting once the suffix reaches two digits, trimming a trailing hyphen', () => {
    const base = `${'a'.repeat(MAX_TAG_PREFIX_LENGTH - 4)}-bc:`;

    for (const attempt of [1, 12]) {
      const candidate = withTagPrefixSuffix(base, attempt);
      expect(candidate.length).toBeLessThanOrEqual(MAX_TAG_PREFIX_LENGTH);
      expect(candidate).toMatch(new RegExp(`[^-]-${attempt}:$`));
    }
  });
});
