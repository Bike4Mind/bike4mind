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
  countLakeReachableAttachments: async () => 0 as number | null,
};

describe('resolvePersonalCorpusOnly', () => {
  it('is true for a notebook holding only personal files', async () => {
    await expect(resolvePersonalCorpusOnly(base)).resolves.toBe(true);
  });

  it('is false when any attachment belongs to a reachable lake', async () => {
    await expect(
      resolvePersonalCorpusOnly({
        ...base,
        requestedKnowledgeIds: ['f1', 'f2'],
        resolvedFiles: [file('f1'), file('f2', ['datalake:orgkb'])],
      })
    ).resolves.toBe(false);
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
  it('is FALSE when the caller attached org-lake files the reader cannot see (zero resolved)', async () => {
    await expect(
      resolvePersonalCorpusOnly({
        ...base,
        requestedKnowledgeIds: ['orgFile1', 'orgFile2'],
        resolvedFiles: [], // reader is blind to lake-membership-reached files
      })
    ).resolves.toBe(false);
  });

  it('is FALSE on a partially-resolved corpus, which cannot be classified either', async () => {
    await expect(
      resolvePersonalCorpusOnly({
        ...base,
        requestedKnowledgeIds: ['f1', 'orgFile2'],
        resolvedFiles: [file('f1')], // one personal file visible, the org-lake one is not
      })
    ).resolves.toBe(false);
  });

  it('is false when the file lookup failed outright', async () => {
    await expect(resolvePersonalCorpusOnly({ ...base, resolvedFiles: null })).resolves.toBe(false);
  });

  it('is false when lake access could not be resolved, rather than assuming no lakes', async () => {
    await expect(resolvePersonalCorpusOnly({ ...base, accessibleLakeTags: new Set() })).resolves.toBe(false);
  });

  it('is false for a session already scoped to a lake', async () => {
    await expect(resolvePersonalCorpusOnly({ ...base, retrievalTags: ['datalake:orgkb'] })).resolves.toBe(false);
  });

  it("is false when the lake's grounding mode makes the tool the intended reader", async () => {
    await expect(resolvePersonalCorpusOnly({ ...base, corpusGroundingMode: 'retrieve' })).resolves.toBe(false);
  });

  /**
   * The organization-lake case again, from the other side: here the ownership reader DID resolve
   * every id (so the count guard passes), but the lake arm reports the files are lake content. That
   * happens when a member owns some files and the lake also claims them, and it is the clause that
   * makes the classification authoritative rather than reader-dependent.
   */
  it('is FALSE when the lake arm reports attached lake content, whatever the other reader saw', async () => {
    await expect(resolvePersonalCorpusOnly({ ...base, countLakeReachableAttachments: async () => 1 })).resolves.toBe(false);
  });

  it('is FALSE when lake reachability could not be determined', async () => {
    await expect(resolvePersonalCorpusOnly({ ...base, countLakeReachableAttachments: async () => null })).resolves.toBe(false);
  });

  it('is false with nothing attached', async () => {
    await expect(resolvePersonalCorpusOnly({ ...base, requestedKnowledgeIds: [], resolvedFiles: [] })).resolves.toBe(false);
  });
});
