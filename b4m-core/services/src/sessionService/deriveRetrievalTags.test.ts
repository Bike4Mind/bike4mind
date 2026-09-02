import { describe, it, expect, vi } from 'vitest';
import { deriveRetrievalTagsFromFiles } from './deriveRetrievalTags';
import type { IUserDocument } from '@bike4mind/common';

const user = { id: 'u1', groups: [] } as unknown as IUserDocument;
const file = (id: string, tagNames: string[]) => ({ id, tags: tagNames.map(name => ({ name })) });

// `lakeViewComplete` defaults to true: every pre-existing case here asserts behaviour under a
// resolver that saw the whole picture. Pass false to model a degraded read.
const makeAdapters = (owned: unknown[], reachable?: string[], lakeViewComplete = true) => ({
  db: {
    fabFiles: {
      shareable: { findAllAccessibleByIds: vi.fn().mockResolvedValue(owned) },
      search: vi.fn().mockResolvedValue({ data: [] }),
    },
  },
  ...(reachable
    ? {
        resolveLakeAccess: vi.fn().mockResolvedValue({
          dataLakeTags: reachable,
          dataLakeTagPrefixes: [],
          scopedTagPrefixes: [],
          lakeViewComplete,
        }),
      }
    : {}),
});

describe('deriveRetrievalTagsFromFiles', () => {
  it('derives the lake tag off an attached lake file', async () => {
    const a = makeAdapters([file('f1', ['datalake:acme'])], ['datalake:acme']);
    await expect(deriveRetrievalTagsFromFiles(user, ['f1'], a as never)).resolves.toEqual(['datalake:acme']);
  });

  /**
   * The ownership arm collects tags off any file the caller can merely READ, so a 1:1-shared file
   * carrying a stale or foreign lake tag would otherwise persist a scope pointing at a lake they
   * cannot reach - narrowing the session to nothing rather than to that lake, and (because a
   * non-empty tag list reads as "already lake-scoped") switching off the personal-corpus
   * suppression permanently. Unrecoverable over-narrowing, not a leak.
   */
  it('drops a derived tag naming a lake the caller cannot reach', async () => {
    const a = makeAdapters([file('f1', ['datalake:foreign'])], ['datalake:acme']);
    await expect(deriveRetrievalTagsFromFiles(user, ['f1'], a as never)).resolves.toEqual([]);
  });

  /**
   * The failure this pins: a dynamic-lake read that FAILS still resolves successfully, returning the
   * static registry alone (getDynamicDataLakeAccess degrades rather than throwing). The org lake is
   * then absent from `dataLakeTags` while the attached file still carries its tag, so intersecting
   * would drop a correct tag and persist an EMPTY scope - which `fabFileSearchQuery` reads as no tag
   * filter at all, widening retrieval to every reachable lake. Worse than not resolving access.
   *
   * Note the registry list is NON-EMPTY here on purpose: guarding only on "empty" would miss this,
   * because a degraded read returns whatever registry lakes the caller is entitled to.
   */
  it('keeps derived tags when the lake view is DEGRADED, even though the tag looks unreachable', async () => {
    const a = makeAdapters([file('f1', ['datalake:acme'])], ['datalake:registry-only'], false);
    await expect(deriveRetrievalTagsFromFiles(user, ['f1'], a as never)).resolves.toEqual(['datalake:acme']);
  });

  it('still intersects when the degraded read returns no lakes at all', async () => {
    const a = makeAdapters([file('f1', ['datalake:acme'])], [], false);
    await expect(deriveRetrievalTagsFromFiles(user, ['f1'], a as never)).resolves.toEqual(['datalake:acme']);
  });

  it('does not intersect when the host cannot resolve lake access, rather than dropping everything', async () => {
    const a = makeAdapters([file('f1', ['datalake:acme'])]); // no resolveLakeAccess
    await expect(deriveRetrievalTagsFromFiles(user, ['f1'], a as never)).resolves.toEqual(['datalake:acme']);
  });

  it('derives nothing from a personal file', async () => {
    const a = makeAdapters([file('f2', ['notes'])], ['datalake:acme']);
    await expect(deriveRetrievalTagsFromFiles(user, ['f2'], a as never)).resolves.toEqual([]);
  });
});
