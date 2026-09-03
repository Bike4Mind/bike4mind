import { describe, it, expect } from 'vitest';
import {
  CreateDataLakeRequestInput,
  ApplyTaxonomyRequestInput,
  UpdateDataLakeRequestInput,
  SetLakeFileTagsRequestInput,
} from './dataLake';
import { MIN_PASSAGE_TOKEN_TARGET, OVERSIZED_PASSAGE_TOKEN_THRESHOLD } from '../constants/chunking';
import {
  MIN_DATA_LAKE_SLUG_LENGTH,
  MAX_DATA_LAKE_SLUG_LENGTH,
  DATA_LAKE_SLUG_REGEX,
  MAX_LAKE_FILE_TAG_NAME_LENGTH,
  MAX_TAG_PREFIX_LENGTH,
  MAX_TAXONOMY_TAG_SUFFIX_LENGTH,
  MAX_TAXONOMY_TAGS,
} from '../constants/dataLakes';

const input = (fileTagPrefix: string) => ({ name: 'Lake', slug: 'my-lake', fileTagPrefix });

const withSlug = (slug: string) => ({ name: 'Lake', slug, fileTagPrefix: 'acme:' });

// The wizard slugifies a lake NAME and gates on the result before this schema runs, so both
// sides size by MIN/MAX_DATA_LAKE_SLUG_LENGTH. Written against the constants, not the numbers:
// this asserts the schema still reads them, which a literal-based test could not.
describe('CreateDataLakeRequestInput.slug', () => {
  // Deliberately NOT phrased as "the .min() rejects this": DATA_LAKE_SLUG_REGEX needs a leading
  // and a trailing alphanumeric in separate positions, so at these values the PATTERN is what
  // refuses a 1-char slug and .min() is unobservable through parse. Asserting the two agree is
  // the honest test - it fires if either the constant or the pattern's effective floor moves,
  // whereas a "below the minimum is rejected" case passes with .min() deleted.
  it('refuses a slug shorter than the shared minimum, and the pattern floor agrees with it', () => {
    const tooShort = 'a'.repeat(MIN_DATA_LAKE_SLUG_LENGTH - 1);
    expect(CreateDataLakeRequestInput.safeParse(withSlug(tooShort)).success).toBe(false);
    expect(tooShort).not.toMatch(DATA_LAKE_SLUG_REGEX);
    expect(CreateDataLakeRequestInput.safeParse(withSlug('a'.repeat(MIN_DATA_LAKE_SLUG_LENGTH))).success).toBe(true);
  });

  it('accepts a slug at the shared maximum and rejects one past it', () => {
    expect(CreateDataLakeRequestInput.safeParse(withSlug('a'.repeat(MAX_DATA_LAKE_SLUG_LENGTH))).success).toBe(true);
    expect(CreateDataLakeRequestInput.safeParse(withSlug('a'.repeat(MAX_DATA_LAKE_SLUG_LENGTH + 1))).success).toBe(
      false
    );
  });

  it('rejects a slug the shared pattern refuses, naming the rule', () => {
    for (const bad of ['My-Lake', 'my_lake', '-my-lake', 'my-lake-']) {
      const result = CreateDataLakeRequestInput.safeParse(withSlug(bad));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some(i => /lowercase alphanumeric with hyphens/.test(i.message))).toBe(true);
      }
    }
  });
});

describe('CreateDataLakeRequestInput.fileTagPrefix', () => {
  it('accepts an ordinary namespaced prefix', () => {
    expect(CreateDataLakeRequestInput.safeParse(input('acme:')).success).toBe(true);
  });

  it('requires a trailing colon', () => {
    expect(CreateDataLakeRequestInput.safeParse(input('acme')).success).toBe(false);
  });

  // Without this, a lake's content prefix could match every other lake's membership meta-tag,
  // and removing a file from it would try to evict the file from all of them.
  it.each(['datalake:', 'datalake:x:'])('rejects the reserved namespace (%s)', prefix => {
    const result = CreateDataLakeRequestInput.safeParse(input(prefix));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => /reserved/i.test(i.message))).toBe(true);
    }
  });

  it('rejects the reserved namespace behind leading whitespace', () => {
    expect(CreateDataLakeRequestInput.safeParse(input('  datalake:')).success).toBe(false);
  });

  // A degenerate prefix ("::", "a::", ":a:", "a: :") gives every derived tag a blank tree
  // segment; the tag-tree UIs can only guard around it downstream, so the schema is the
  // durable gate. Whitespace-only and zero-width segments (U+200B/U+2060 survive trim())
  // are the same failure mode as bare "::".
  it.each(['::', 'a::', ':a:', 'a::b:', 'a: :', 'acme: :', 'a:\u200b:', 'a:\u2060:', 'a:\u3164:', 'a:\u2800:'])(
    'rejects a prefix with a blank segment (%s)',
    prefix => {
      const result = CreateDataLakeRequestInput.safeParse(input(prefix));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some(i => /non-empty/i.test(i.message))).toBe(true);
      }
    }
  );

  it('accepts a multi-segment prefix with non-empty segments', () => {
    expect(CreateDataLakeRequestInput.safeParse(input('acme:legal:')).success).toBe(true);
  });

  it('accepts non-Latin prefixes', () => {
    expect(CreateDataLakeRequestInput.safeParse(input('\u0444\u0430\u0439\u043b\u044b:')).success).toBe(true);
    expect(CreateDataLakeRequestInput.safeParse(input('\u6587\u4ef6:')).success).toBe(true);
  });

  // Consumers split between raw reads (tree roots) and normalizeTagPrefix reads (tag
  // stamping); an untrimmed " acme:" stored raw would desynchronize them.
  it('trims edge whitespace so the stored prefix equals its normalized form', () => {
    const result = CreateDataLakeRequestInput.safeParse(input('  acme:  '));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fileTagPrefix).toBe('acme:');
    }
  });

  // Without the endsWith guard inside the segment check, slice(0, -1) on a colon-less
  // prefix chops real content and manufactures a phantom "empty segment" issue next to
  // the real trailing-colon one - misleading for API-key callers reading the issue list.
  it('reports only the trailing-colon issue for a colon-less prefix', () => {
    const result = CreateDataLakeRequestInput.safeParse(input('a:b'));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => /must end with/i.test(i.message))).toBe(true);
      expect(result.error.issues.some(i => /non-empty/i.test(i.message))).toBe(false);
    }
  });
});

// Bounds cap worst-case request size/storage/CPU from a crafted body (see comment in
// dataLake.ts) - a batch with thousands of files times an oversized tag list is real
// amplification, not just a validation nicety.
describe('ApplyTaxonomyRequestInput - size bounds', () => {
  const tag = (overrides: Partial<Record<string, unknown>> = {}) => ({
    suffix: 'type:contract',
    originalName: 'acme:type:contract',
    strength: 0.9,
    source: 'ai',
    matchingFolders: ['legal'],
    deleted: false,
    ...overrides,
  });

  it('accepts an ordinary, small tag list', () => {
    expect(ApplyTaxonomyRequestInput.safeParse({ tags: [tag()] }).success).toBe(true);
  });

  it('rejects more than 100 tags', () => {
    const tags = Array.from({ length: 101 }, (_, i) => tag({ originalName: `acme:type:${i}` }));
    expect(ApplyTaxonomyRequestInput.safeParse({ tags }).success).toBe(false);
  });

  it('rejects an oversized suffix or originalName', () => {
    expect(ApplyTaxonomyRequestInput.safeParse({ tags: [tag({ suffix: 'x'.repeat(101) })] }).success).toBe(false);
    expect(ApplyTaxonomyRequestInput.safeParse({ tags: [tag({ originalName: 'x'.repeat(151) })] }).success).toBe(false);
  });

  it('rejects an empty suffix or originalName', () => {
    expect(ApplyTaxonomyRequestInput.safeParse({ tags: [tag({ suffix: '' })] }).success).toBe(false);
    expect(ApplyTaxonomyRequestInput.safeParse({ tags: [tag({ originalName: '' })] }).success).toBe(false);
  });

  it('rejects an oversized matchingFolders list or an oversized entry', () => {
    expect(
      ApplyTaxonomyRequestInput.safeParse({ tags: [tag({ matchingFolders: Array(101).fill('legal') })] }).success
    ).toBe(false);
    expect(ApplyTaxonomyRequestInput.safeParse({ tags: [tag({ matchingFolders: ['x'.repeat(513)] })] }).success).toBe(
      false
    );
  });
});

describe('UpdateDataLakeRequestInput.requiredPassageTokenTarget', () => {
  // The lake-level route into #1804. A lake requiring a target above the under-chunked detection
  // threshold has members that re-chunk to a compliant size and STILL trip detection, so its
  // rebuild badge never reaches zero. Bounding only the DefaultChunkSize setting leaves this open.
  const parse = (requiredPassageTokenTarget: number | null) =>
    UpdateDataLakeRequestInput.safeParse({ requiredPassageTokenTarget });

  it('rejects a required target above the detection threshold', () => {
    expect(parse(OVERSIZED_PASSAGE_TOKEN_THRESHOLD + 1).success).toBe(false);
    expect(parse(8192).success).toBe(false); // the old ceiling
  });

  it('accepts the threshold itself, which is convergent because detection is $gt', () => {
    expect(parse(OVERSIZED_PASSAGE_TOKEN_THRESHOLD).success).toBe(true);
  });

  it('still accepts the floor and the explicit clear sentinel', () => {
    expect(parse(MIN_PASSAGE_TOKEN_TARGET).success).toBe(true);
    expect(parse(MIN_PASSAGE_TOKEN_TARGET - 1).success).toBe(false);
    expect(parse(null).success).toBe(true);
  });
});

describe('SetLakeFileTagsRequestInput', () => {
  // Pinned to its derivation rather than a literal 130, so a future edit to either summand is
  // caught here instead of silently drifting the schema away from the constant it is supposed
  // to track.
  it('MAX_LAKE_FILE_TAG_NAME_LENGTH is derived from the prefix and taxonomy-suffix caps', () => {
    expect(MAX_LAKE_FILE_TAG_NAME_LENGTH).toBe(MAX_TAG_PREFIX_LENGTH + MAX_TAXONOMY_TAG_SUFFIX_LENGTH);
  });

  it('requires `tags` - an absent field must never read as the empty set', () => {
    expect(SetLakeFileTagsRequestInput.safeParse({}).success).toBe(false);
  });

  it('accepts an empty array (a real, deliberate "clear everything under this prefix" request)', () => {
    expect(SetLakeFileTagsRequestInput.safeParse({ tags: [] }).success).toBe(true);
  });

  it(`rejects more than ${MAX_TAXONOMY_TAGS} tags`, () => {
    const tags = Array.from({ length: MAX_TAXONOMY_TAGS + 1 }, (_, i) => `lk:t${i}`);
    expect(SetLakeFileTagsRequestInput.safeParse({ tags }).success).toBe(false);
  });

  it(`accepts exactly ${MAX_TAXONOMY_TAGS} tags`, () => {
    const tags = Array.from({ length: MAX_TAXONOMY_TAGS }, (_, i) => `lk:t${i}`);
    expect(SetLakeFileTagsRequestInput.safeParse({ tags }).success).toBe(true);
  });

  it('accepts a name exactly at MAX_LAKE_FILE_TAG_NAME_LENGTH and rejects one character over', () => {
    const atLimit = `lk:${'x'.repeat(MAX_LAKE_FILE_TAG_NAME_LENGTH - 'lk:'.length)}`;
    expect(atLimit).toHaveLength(MAX_LAKE_FILE_TAG_NAME_LENGTH);
    expect(SetLakeFileTagsRequestInput.safeParse({ tags: [atLimit] }).success).toBe(true);
    expect(SetLakeFileTagsRequestInput.safeParse({ tags: [`${atLimit}x`] }).success).toBe(false);
  });

  it('rejects an empty-string name', () => {
    expect(SetLakeFileTagsRequestInput.safeParse({ tags: [''] }).success).toBe(false);
  });

  it('rejects a name containing a newline', () => {
    expect(SetLakeFileTagsRequestInput.safeParse({ tags: ['lk:a\nb'] }).success).toBe(false);
    expect(SetLakeFileTagsRequestInput.safeParse({ tags: ['lk:a\rb'] }).success).toBe(false);
  });
});
