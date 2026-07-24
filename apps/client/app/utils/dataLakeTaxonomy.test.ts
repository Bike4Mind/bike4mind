import { describe, it, expect } from 'vitest';
import type { TaxonomyResult, TaxonomyTag } from '@client/app/stores/useDataLakeWizardStore';
import { appliedTagsForBatch, folderMatches, reprefixTag, tagsForFile } from './dataLakeTaxonomy';

/**
 * Regression coverage: the Taxonomy step used to be pure theater - inference returned
 * categories and per-file assignments, the user edited them, and the upload path threw
 * all of it away in favor of a folder slug. These tests pin the review edits (rename,
 * delete) to what actually ships in the presigned-URL request.
 */

const tag = (overrides: Partial<TaxonomyTag> & { name: string }): TaxonomyTag => ({
  originalName: overrides.name,
  strength: 0.9,
  source: 'ai',
  matchingFolders: [],
  deleted: false,
  ...overrides,
});

const taxonomy = (overrides: Partial<TaxonomyResult> = {}): TaxonomyResult => ({
  prefix: 'acme:',
  sourcePrefix: 'acme:',
  suggestedName: 'Acme',
  tags: [],
  fileAssignments: [],
  attempted: true,
  analyzing: false,
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
});

describe('reprefixTag', () => {
  it('swaps the inferred prefix for the one the user settled on', () => {
    expect(reprefixTag('acme:type:contract', 'acme:', 'lake:')).toBe('lake:type:contract');
  });

  it('tolerates prefixes given without the trailing colon', () => {
    expect(reprefixTag('acme:type:contract', 'acme', 'lake')).toBe('lake:type:contract');
  });

  it('prefixes rather than rewrites a tag that does not carry the inferred prefix', () => {
    // Dropping the leading segment here would silently turn "type:contract" into
    // "lake:contract" and lose the dimension.
    expect(reprefixTag('type:contract', 'acme:', 'lake:')).toBe('lake:type:contract');
  });

  it('leaves an already-correct tag untouched', () => {
    expect(reprefixTag('lake:type:contract', '', 'lake:')).toBe('lake:type:contract');
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
          tag({ name: 'acme:type:contract', matchingFolders: ['legal/agreements'] }),
          tag({ name: 'acme:topic:finance', matchingFolders: ['finance'] }),
        ],
      }),
      'acme:'
    );
    expect(names(result)).toEqual(['acme:agreements', 'acme:type:contract']);
  });

  it('drops categories the user deleted', () => {
    const result = tagsForFile(
      'root/legal/vendor.pdf',
      taxonomy({ tags: [tag({ name: 'acme:type:contract', matchingFolders: ['legal'], deleted: true })] }),
      'acme:'
    );
    expect(names(result)).toEqual(['acme:legal']);
  });

  it('honors a rename, including for per-file assignments that reference the original name', () => {
    const result = tagsForFile(
      'root/legal/vendor.pdf',
      taxonomy({
        tags: [tag({ name: 'acme:type:agreement', originalName: 'acme:type:contract', matchingFolders: ['legal'] })],
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

  it('rewrites taxonomy tags to the final prefix so a lake never mixes namespaces', () => {
    const result = tagsForFile(
      'root/legal/vendor.pdf',
      taxonomy({ tags: [tag({ name: 'acme:type:contract', matchingFolders: ['legal'] })] }),
      'renamed:'
    );
    expect(names(result)).toEqual(['renamed:legal', 'renamed:type:contract']);
  });

  it('caps how many categories a single file can accumulate, keeping the strongest', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      tag({ name: `acme:cat${i}`, matchingFolders: ['legal'], strength: i / 12 })
    );
    const result = tagsForFile('root/legal/vendor.pdf', taxonomy({ tags: many }), 'acme:');
    expect(result).toHaveLength(9); // 8 taxonomy tags + the folder tag
    expect(result.map(t => t.name)).toContain('acme:cat11');
    expect(result.map(t => t.name)).not.toContain('acme:cat0');
  });

  it('does not duplicate a taxonomy tag that equals the folder tag', () => {
    const result = tagsForFile(
      'root/legal/vendor.pdf',
      taxonomy({ tags: [tag({ name: 'acme:legal', matchingFolders: ['legal'] })] }),
      'acme:'
    );
    expect(names(result)).toEqual(['acme:legal']);
  });

  it('returns nothing for a root-level file no category covers (it gets the lake meta-tag server-side)', () => {
    expect(tagsForFile('readme.md', taxonomy(), 'acme:')).toEqual([]);
  });
});

describe('appliedTagsForBatch', () => {
  it('unions every tag the batch will apply', () => {
    const result = appliedTagsForBatch(
      [{ relativePath: 'root/legal/a.pdf' }, { relativePath: 'root/finance/b.pdf' }],
      taxonomy({ tags: [tag({ name: 'acme:type:contract', matchingFolders: ['legal'] })] }),
      'acme:'
    );
    expect(names(result)).toEqual(['acme:finance', 'acme:legal', 'acme:type:contract']);
  });
});
