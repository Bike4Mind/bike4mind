import { describe, it, expect } from 'vitest';
import type { TaxonomyTag, TaxonomyTagSet } from '../types/entities/DataLakeTypes';
import {
  appliedTagsForBatch,
  folderMatches,
  folderTagForFile,
  sanitizeCategories,
  tagsForFile,
} from './dataLakeTaxonomy';

/**
 * Regression coverage: the Taxonomy step used to be pure theater - inference returned
 * categories and per-file assignments, the user edited them, and the upload path threw
 * all of it away in favor of a folder slug. These tests pin the review edits (edit, delete)
 * to what actually ships. The applied tag is `prefix + suffix`, so the prefix lives once
 * (the passed tagPrefix), never per-tag.
 */

const tag = (overrides: Partial<TaxonomyTag> & { suffix: string }): TaxonomyTag => ({
  originalName: `acme:${overrides.suffix}`,
  strength: 0.9,
  source: 'ai',
  matchingFolders: [],
  deleted: false,
  ...overrides,
});

const taxonomy = (overrides: Partial<TaxonomyTagSet> = {}): TaxonomyTagSet => ({
  tags: [],
  fileAssignments: [],
  ...overrides,
});

const names = (tags: { name: string }[]) => tags.map(t => t.name).sort();

describe('folderMatches', () => {
  it('matches a multi-segment folder path anywhere in the file path', () => {
    expect(folderMatches(['root', 'legal', 'agreements', '2024'], 'legal/agreements')).toBe(true);
  });

  it('does not match segments that are merely adjacent out of order', () => {
    expect(folderMatches(['root', 'agreements', 'legal'], 'legal/agreements')).toBe(false);
  });

  it('ignores case, surrounding slashes, and empty entries', () => {
    expect(folderMatches(['root', 'legal'], '/Legal/')).toBe(true);
    expect(folderMatches(['root', 'legal'], '')).toBe(false);
  });

  it('matches slugified and raw spellings of the same folder', () => {
    expect(folderMatches(['root', 'legal_docs'], 'Legal Docs')).toBe(true);
    expect(folderMatches(['root', 'legal_docs'], 'legal-docs')).toBe(true);
  });
});

describe('tagsForFile', () => {
  it('falls back to the folder tag when there is no taxonomy', () => {
    expect(tagsForFile('root/reports/q1.pdf', taxonomy(), 'lake:')).toEqual([{ name: 'lake:reports', strength: 1.0 }]);
  });

  it('applies categories whose folders cover the file, alongside the folder tag', () => {
    const result = tagsForFile(
      'root/legal/agreements/vendor.pdf',
      taxonomy({
        tags: [
          tag({ suffix: 'type:contract', matchingFolders: ['legal/agreements'] }),
          tag({ suffix: 'topic:finance', matchingFolders: ['finance'] }),
        ],
      }),
      'acme:'
    );
    expect(names(result)).toEqual(['acme:agreements', 'acme:type:contract']);
  });

  it('drops categories the user deleted', () => {
    const result = tagsForFile(
      'root/legal/vendor.pdf',
      taxonomy({ tags: [tag({ suffix: 'type:contract', matchingFolders: ['legal'], deleted: true })] }),
      'acme:'
    );
    expect(names(result)).toEqual(['acme:legal']);
  });

  it('honors an edited suffix, including for per-file assignments that reference the original name', () => {
    const result = tagsForFile(
      'root/legal/vendor.pdf',
      taxonomy({
        // originalName stays the inference id; the user edited the suffix to "type:agreement".
        tags: [tag({ suffix: 'type:agreement', originalName: 'acme:type:contract', matchingFolders: ['legal'] })],
        fileAssignments: [
          { relativePath: 'root/legal/vendor.pdf', suggestedTags: [{ name: 'acme:type:contract', strength: 0.95 }] },
        ],
      }),
      'acme:'
    );
    expect(names(result)).toEqual(['acme:legal', 'acme:type:agreement']);
    expect(result.find(t => t.name === 'acme:type:agreement')?.strength).toBe(0.95);
  });

  it('ignores assignments for tags that were never declared as categories', () => {
    const result = tagsForFile(
      'root/legal/vendor.pdf',
      taxonomy({
        fileAssignments: [
          { relativePath: 'root/legal/vendor.pdf', suggestedTags: [{ name: 'acme:invented', strength: 1 }] },
        ],
      }),
      'acme:'
    );
    expect(names(result)).toEqual(['acme:legal']);
  });

  it('applies the passed prefix to every suffix so a lake never mixes namespaces', () => {
    const result = tagsForFile(
      'root/legal/vendor.pdf',
      taxonomy({ tags: [tag({ suffix: 'type:contract', matchingFolders: ['legal'] })] }),
      'renamed:'
    );
    expect(names(result)).toEqual(['renamed:legal', 'renamed:type:contract']);
  });

  it('applies the same prefix to folder tags and category tags even when it is bare', () => {
    // Empty prefix is gated in the UI, but the pure fn must at least be consistent: folder
    // tag and category tag both go through ensureColon, so both get the same leading colon.
    const result = tagsForFile(
      'root/legal/vendor.pdf',
      taxonomy({ tags: [tag({ suffix: 'type:contract', matchingFolders: ['legal'] })] }),
      ''
    );
    expect(names(result)).toEqual([':legal', ':type:contract']);
  });

  it('trims a stored prefix so every tag lands under the normalized namespace', () => {
    // A lake row predating the create schema's trim can hold " acme:" (#2467). The write doors
    // gate on the NORMALIZED prefix and every read arm trims before matching, so a builder that
    // appended to the raw value would write " acme:legal" - a name nothing can see.
    const result = tagsForFile(
      'root/legal/vendor.pdf',
      taxonomy({ tags: [tag({ suffix: 'type:contract', matchingFolders: ['legal'] })] }),
      ' acme: '
    );
    expect(names(result)).toEqual(['acme:legal', 'acme:type:contract']);
  });

  it('caps how many categories a single file can accumulate, keeping the strongest', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      tag({ suffix: `cat${i}`, matchingFolders: ['legal'], strength: i / 12 })
    );
    const result = tagsForFile('root/legal/vendor.pdf', taxonomy({ tags: many }), 'acme:');
    expect(result).toHaveLength(9); // 8 taxonomy tags + the folder tag
    expect(result.map(t => t.name)).toContain('acme:cat11');
    expect(result.map(t => t.name)).not.toContain('acme:cat0');
  });

  it('does not duplicate a taxonomy tag that equals the folder tag', () => {
    const result = tagsForFile(
      'root/legal/vendor.pdf',
      taxonomy({ tags: [tag({ suffix: 'legal', matchingFolders: ['legal'] })] }),
      'acme:'
    );
    expect(names(result)).toEqual(['acme:legal']);
  });

  it('returns nothing for a root-level file no category covers (it gets the lake meta-tag server-side)', () => {
    expect(tagsForFile('readme.md', taxonomy(), 'acme:')).toEqual([]);
  });

  it('applies a category to a folder whose name needed slugifying', () => {
    // Regression: the folder tag slugified ("Legal Docs" -> legal_docs) while matching
    // compared raw segments, so any folder with a space silently lost its taxonomy tags.
    const result = tagsForFile(
      'root/Legal Docs/vendor.pdf',
      taxonomy({ tags: [tag({ suffix: 'type:contract', matchingFolders: ['Legal Docs'] })] }),
      'acme:'
    );
    expect(names(result)).toEqual(['acme:legal_docs', 'acme:type:contract']);
  });
});

describe('folderTagForFile', () => {
  it('trims a stored prefix, so the upload pipeline and the apply door share one namespace', () => {
    // The upload pipeline passes the lake's RAW fileTagPrefix (dataLakeUploadPipeline.ts) while
    // applyTaxonomySuggestions passes the gate's normalized one. Both must produce the same name
    // for the same file, or a re-apply's folder-tag subtraction stops matching what upload wrote
    // and the file picks up the folder tag twice under two spellings.
    expect(folderTagForFile('root/legal/vendor.pdf', ' acme: ')).toEqual(
      folderTagForFile('root/legal/vendor.pdf', 'acme:')
    );
    expect(folderTagForFile('root/legal/vendor.pdf', ' acme: ')).toEqual([{ name: 'acme:legal', strength: 1.0 }]);
  });
});

describe('sanitizeCategories', () => {
  it('caps the number of categories at 100, mirroring ApplyTaxonomyRequestInput', () => {
    const categories = Array.from({ length: 150 }, (_, i) => ({ tagName: `type:cat${i}` }));

    const result = sanitizeCategories(categories, 'acme');

    expect(result).toHaveLength(100);
  });

  it('caps matchingFolders per category at 100, mirroring ApplyTaxonomyRequestInput', () => {
    const matchingFolders = Array.from({ length: 150 }, (_, i) => `folder${i}`);

    const result = sanitizeCategories([{ tagName: 'type:contract', matchingFolders }], 'acme');

    expect(result[0]?.matchingFolders).toHaveLength(100);
  });

  it('truncates originalName at 150 chars and suffix at 100 chars, mirroring ApplyTaxonomyRequestInput', () => {
    const longName = `type:${'x'.repeat(200)}`;

    const result = sanitizeCategories([{ tagName: longName }], 'acme');

    expect(result[0]?.originalName.length).toBeLessThanOrEqual(150);
    expect(result[0]?.suffix.length).toBeLessThanOrEqual(100);
  });

  it('truncates each matchingFolders entry at 512 chars, mirroring ApplyTaxonomyRequestInput', () => {
    const longFolder = 'a/'.repeat(400);

    const result = sanitizeCategories([{ tagName: 'type:contract', matchingFolders: [longFolder] }], 'acme');

    expect(result[0]?.matchingFolders[0]?.length).toBeLessThanOrEqual(512);
  });
});

describe('sanitizeCategories with an un-trimmed source prefix', () => {
  it('still strips the inferred prefix, so the suffix does not carry it a second time', () => {
    // deriveSuffix compares against the same normalized prefix the builders apply. Without that,
    // a lake stored as " acme:" would keep "acme:contract" whole as the suffix and tagsForFile
    // would then emit "acme:acme:contract".
    const [category] = sanitizeCategories(
      [{ tagName: 'acme:contract', confidence: 0.8, matchingFolders: [] }],
      ' acme:'
    );
    expect(category.suffix).toBe('contract');
  });
});

describe('appliedTagsForBatch', () => {
  it('unions every tag the batch will apply', () => {
    const result = appliedTagsForBatch(
      [{ relativePath: 'root/legal/a.pdf' }, { relativePath: 'root/finance/b.pdf' }],
      taxonomy({ tags: [tag({ suffix: 'type:contract', matchingFolders: ['legal'] })] }),
      'acme:'
    );
    expect(names(result)).toEqual(['acme:finance', 'acme:legal', 'acme:type:contract']);
  });
});
