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
