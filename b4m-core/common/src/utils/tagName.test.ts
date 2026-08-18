import { describe, it, expect } from 'vitest';
import { matchTagDocument, resolveFileTagDocs } from './tagName';

/**
 * The trim/fold/data-lake helpers are covered from the tagService side
 * (services/src/tagService/tagName.test.ts, which imports them through the re-export). This file
 * covers the two resolution helpers the chip rendering uses.
 */

const DOCS = [
  { id: 'lower', name: 'run2-alpha' },
  { id: 'upper', name: 'RUN2-Alpha' },
];
const ONE_DOC = [{ id: 'lower', name: 'run2-alpha' }];

describe('matchTagDocument', () => {
  it('prefers the document whose name matches exactly', () => {
    expect(matchTagDocument('RUN2-Alpha', DOCS)?.id).toBe('upper');
    expect(matchTagDocument('run2-alpha', DOCS)?.id).toBe('lower');
  });

  // Files can store a casing no document uses - toggleTags writes the name as the caller spelled it,
  // and legacy rows predate that. One document folding to it is unambiguous, so it claims the name.
  it('falls back to the only document that folds to the name', () => {
    expect(matchTagDocument('RUN2-ALPHA', ONE_DOC)?.id).toBe('lower');
  });

  // The load-bearing case. Crediting either document is a guess, and guessing is what drew a
  // `RUN2-Alpha` chip on files that only ever carried `run2-alpha`.
  it('claims nothing when more than one document folds to the name', () => {
    expect(matchTagDocument('RUN2-ALPHA', DOCS)).toBeUndefined();
  });

  it('returns nothing when no document matches at all', () => {
    expect(matchTagDocument('run2-beta', DOCS)).toBeUndefined();
  });

  it('does not match a name that merely shares a prefix', () => {
    expect(matchTagDocument('run2-alphabet', ONE_DOC)).toBeUndefined();
  });

  it('handles an empty document list', () => {
    expect(matchTagDocument('run2-alpha', [])).toBeUndefined();
  });

  // A padded stored name is legacy data - both write paths trim now. It still resolves while one
  // document folds to it, but must NOT win the exact arm against a pair: that would pick a side.
  it('resolves a whitespace-padded stored name while only one document folds to it', () => {
    expect(matchTagDocument('  run2-alpha  ', ONE_DOC)?.id).toBe('lower');
  });

  it('claims nothing for a padded stored name when a case pair exists', () => {
    expect(matchTagDocument('  run2-alpha  ', DOCS)).toBeUndefined();
  });
});

describe('resolveFileTagDocs', () => {
  // The defect this replaces: with both documents present, a file carrying only `run2-alpha`
  // rendered a chip for each document, so every file in the lowercase tag grew a phantom
  // `RUN2-Alpha` chip after one unrelated apply.
  const idsFor = (names: string[], docs: typeof DOCS) => resolveFileTagDocs(names, docs).map(d => d.id);

  it('resolves only the names the file actually stores', () => {
    expect(idsFor(['run2-alpha'], DOCS)).toEqual(['lower']);
  });

  it('keeps both documents when the file genuinely carries both names', () => {
    expect(idsFor(['run2-alpha', 'RUN2-Alpha'], DOCS)).toEqual(['lower', 'upper']);
  });

  // Two stored casings collapsing onto one document must still be one chip.
  it('dedupes names that resolve to the same document', () => {
    expect(idsFor(['run2-alpha', 'RUN2-ALPHA'], ONE_DOC)).toEqual(['lower']);
  });

  it('drops a name no document claims', () => {
    expect(idsFor(['run2-alpha', 'shared-only'], ONE_DOC)).toEqual(['lower']);
  });

  it('drops an ambiguous name rather than picking a side', () => {
    expect(idsFor(['RUN2-ALPHA'], DOCS)).toEqual([]);
  });

  it('preserves the order the file stores its tags in', () => {
    expect(idsFor(['RUN2-Alpha', 'run2-alpha'], DOCS)).toEqual(['upper', 'lower']);
  });

  it('handles a file with no tags', () => {
    expect(resolveFileTagDocs([], DOCS)).toEqual([]);
  });
});
