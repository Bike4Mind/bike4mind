import { describe, it, expect } from 'vitest';
import { resolvePersonalCorpusOnly } from './resolvePersonalCorpusOnly';
import type { IFabFileDocument } from '@bike4mind/common';

const file = (id: string, tagNames: string[] = []) =>
  ({ id, tags: tagNames.map(name => ({ name })) }) as unknown as IFabFileDocument;

const LAKES = new Set(['datalake:orgkb']);

const base = {
  requestedKnowledgeIds: ['f1'],
  resolvedFiles: [file('f1')],
  accessibleLakeTags: LAKES,
  retrievalTags: undefined as string[] | undefined,
  corpusGroundingMode: undefined as string | undefined,
};

describe('resolvePersonalCorpusOnly', () => {
  it('is true for a notebook holding only personal files', () => {
    expect(resolvePersonalCorpusOnly(base)).toBe(true);
  });

  it('is false when any attachment belongs to a reachable lake', () => {
    expect(
      resolvePersonalCorpusOnly({
        ...base,
        requestedKnowledgeIds: ['f1', 'f2'],
        resolvedFiles: [file('f1'), file('f2', ['datalake:orgkb'])],
      })
    ).toBe(false);
  });

  /**
   * The organization-lake API case, and the reason the count guard exists.
   *
   * An org lake widens reach through the lake creator's identity, so a member attaching org-lake
   * files they do not personally own resolves to a SHORT (often empty) list from an ownership/share
   * based reader. `[].every(...)` is `true`, so without the count guard "I could not see any of
   * these files" reads as "none of them are lake files" and suppresses retrieval - and on the
   * public API's grounded path the knowledge tool is not offered either, so the turn would have NO
   * retrieval at all, silently.
   */
  it('is FALSE when the caller attached org-lake files the reader cannot see (zero resolved)', () => {
    expect(
      resolvePersonalCorpusOnly({
        ...base,
        requestedKnowledgeIds: ['orgFile1', 'orgFile2'],
        resolvedFiles: [], // reader is blind to lake-membership-reached files
      })
    ).toBe(false);
  });

  it('is FALSE on a partially-resolved corpus, which cannot be classified either', () => {
    expect(
      resolvePersonalCorpusOnly({
        ...base,
        requestedKnowledgeIds: ['f1', 'orgFile2'],
        resolvedFiles: [file('f1')], // one personal file visible, the org-lake one is not
      })
    ).toBe(false);
  });

  it('is false when the file lookup failed outright', () => {
    expect(resolvePersonalCorpusOnly({ ...base, resolvedFiles: null })).toBe(false);
  });

  it('is false when lake access could not be resolved, rather than assuming no lakes', () => {
    expect(resolvePersonalCorpusOnly({ ...base, accessibleLakeTags: new Set() })).toBe(false);
  });

  it('is false for a session already scoped to a lake', () => {
    expect(resolvePersonalCorpusOnly({ ...base, retrievalTags: ['datalake:orgkb'] })).toBe(false);
  });

  it("is false when the lake's grounding mode makes the tool the intended reader", () => {
    expect(resolvePersonalCorpusOnly({ ...base, corpusGroundingMode: 'retrieve' })).toBe(false);
  });

  it('is false with nothing attached', () => {
    expect(resolvePersonalCorpusOnly({ ...base, requestedKnowledgeIds: [], resolvedFiles: [] })).toBe(false);
  });
});
