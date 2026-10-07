import { describe, it, expect, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';
import { filterAccessibleKnowledgeIds } from './filterAccessibleKnowledgeIds';

const OWN = '507f1f77bcf86cd799439001';
const FOREIGN = '507f1f77bcf86cd799439002';
const LAKE = '507f1f77bcf86cd799439003';
const user = { id: 'user-1', groups: ['g1'] } as unknown as IUserDocument;
const logger = { warn: vi.fn() } as never;

/** Resolves OWN always, LAKE only when lake arms are passed; FOREIGN never. */
const makeFabFiles = () => ({
  findAccessibleInIds: vi.fn(async (ids: string[], _access: unknown, lakeAccess?: { lakeMemberships?: unknown[] }) =>
    ids.filter(id => id === OWN || (id === LAKE && lakeAccess?.lakeMemberships?.length)).map(id => ({ id }))
  ),
});

describe('filterAccessibleKnowledgeIds', () => {
  it('drops a foreign id and keeps accessible ones in input order', async () => {
    const fabFiles = makeFabFiles();
    const kept = await filterAccessibleKnowledgeIds(user, [FOREIGN, OWN], { db: { fabFiles }, logger });
    expect(kept).toEqual([OWN]);
    expect(fabFiles.findAccessibleInIds).toHaveBeenCalledWith(
      [FOREIGN, OWN],
      { userId: 'user-1', userGroups: ['g1'] },
      undefined
    );
  });

  it('keeps a lake file when the resolver supplies its arms', async () => {
    const fabFiles = makeFabFiles();
    const kept = await filterAccessibleKnowledgeIds(user, [LAKE], {
      db: { fabFiles },
      logger,
      resolveAttachmentLakeAccess: async () => ({ lakeMemberships: [{ lakeId: 'l1' }] as never }),
    });
    expect(kept).toEqual([LAKE]);
  });

  it('keeps unresolved ids when lake resolution failed, rather than reading an outage as a deny', async () => {
    const fabFiles = makeFabFiles();
    const kept = await filterAccessibleKnowledgeIds(user, [LAKE, OWN], {
      db: { fabFiles },
      logger,
      resolveAttachmentLakeAccess: async () => ({ resolutionFailed: true }),
    });
    expect(kept).toEqual([LAKE, OWN]);
  });

  it('treats a throwing resolver as a failed resolution', async () => {
    const fabFiles = makeFabFiles();
    const kept = await filterAccessibleKnowledgeIds(user, [LAKE], {
      db: { fabFiles },
      logger,
      resolveAttachmentLakeAccess: () => Promise.reject(new Error('boom')),
    });
    expect(kept).toEqual([LAKE]);
  });

  it('does not query for an empty list', async () => {
    const fabFiles = makeFabFiles();
    expect(await filterAccessibleKnowledgeIds(user, [], { db: { fabFiles }, logger })).toEqual([]);
    expect(fabFiles.findAccessibleInIds).not.toHaveBeenCalled();
  });
});
