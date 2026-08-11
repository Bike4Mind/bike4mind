import { describe, it, expect } from 'vitest';
import { CreateDataLakeRequestInput, ApplyTaxonomyRequestInput } from './dataLake';

const input = (fileTagPrefix: string) => ({ name: 'Lake', slug: 'my-lake', fileTagPrefix });

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
