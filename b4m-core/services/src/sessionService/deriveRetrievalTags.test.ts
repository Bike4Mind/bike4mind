import { describe, it, expect, vi } from 'vitest';
import { deriveRetrievalTagsFromFiles } from './deriveRetrievalTags';
import type { IUserDocument } from '@bike4mind/common';

const user = { id: 'u1', groups: [] } as unknown as IUserDocument;
const file = (id: string, tagNames: string[]) => ({ id, tags: tagNames.map(name => ({ name })) });

const makeAdapters = (owned: unknown[], reachable?: string[]) => ({
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

  it('does not intersect when the host cannot resolve lake access, rather than dropping everything', async () => {
    const a = makeAdapters([file('f1', ['datalake:acme'])]); // no resolveLakeAccess
    await expect(deriveRetrievalTagsFromFiles(user, ['f1'], a as never)).resolves.toEqual(['datalake:acme']);
  });

  it('derives nothing from a personal file', async () => {
    const a = makeAdapters([file('f2', ['notes'])], ['datalake:acme']);
    await expect(deriveRetrievalTagsFromFiles(user, ['f2'], a as never)).resolves.toEqual([]);
  });
});
