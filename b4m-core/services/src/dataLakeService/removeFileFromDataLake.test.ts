import { describe, it, expect, vi } from 'vitest';
import { removeFileFromDataLake } from './removeFileFromDataLake';

const lake = {
  id: 'lake1',
  name: 'Lake',
  datalakeTag: 'datalake:lake',
  fileTagPrefix: 'lk:',
  createdByUserId: 'owner',
  organizationId: undefined,
  status: 'active' as const,
};

const fileInLake = {
  id: 'f1',
  userId: 'owner',
  tags: [
    { name: 'datalake:lake', strength: 1 },
    { name: 'lk:invoices', strength: 1 },
  ],
};

const actor = { userId: 'owner', isAdmin: false };

const makeAdapters = (overrides: { fileById?: unknown } = {}) => {
  const order: string[] = [];
  const db = {
    dataLakes: {
      findById: vi.fn().mockResolvedValue(lake),
      setStats: vi.fn().mockResolvedValue(undefined),
      activateIfDraft: vi.fn().mockResolvedValue(false),
    },
    fabFiles: {
      findById: vi.fn().mockResolvedValue(overrides.fileById ?? fileInLake),
      pullTagsByFabFileId: vi.fn().mockImplementation(async () => {
        order.push('pullTagsByFabFileId');
        return 1;
      }),
      computeDataLakeStats: vi.fn().mockImplementation(async () => {
        order.push('computeDataLakeStats');
        return { fileCount: 0, totalSizeBytes: 0, totalChunkedChars: 0 };
      }),
    },
    dataLakeAccessGrants: { listByLake: vi.fn().mockResolvedValue([]) },
    lakeMembershipRemovals: {
      upsertRemoval: vi.fn().mockImplementation(async () => {
        order.push('upsertRemoval');
        return {};
      }),
    },
  };
  const logger = { warn: vi.fn(), error: vi.fn() };
  return { db, logger, order };
};

describe('removeFileFromDataLake', () => {
  it('writes the removal record with the removed contentTags and the acting principal', async () => {
    const { db, logger } = makeAdapters();

    await removeFileFromDataLake(actor, 'lake1', 'f1', { db, logger });

    expect(db.lakeMembershipRemovals.upsertRemoval).toHaveBeenCalledWith({
      dataLakeId: 'lake1',
      fabFileId: 'f1',
      actorUserId: 'owner',
      contentTags: [{ name: 'lk:invoices', strength: 1 }],
      removedAt: expect.any(Date),
      expiresAt: expect.any(Date),
    });
  });

  it('sets a 30-minute expiry from the removal time', async () => {
    const { db, logger } = makeAdapters();

    await removeFileFromDataLake(actor, 'lake1', 'f1', { db, logger });

    const call = db.lakeMembershipRemovals.upsertRemoval.mock.calls[0][0] as {
      removedAt: Date;
      expiresAt: Date;
    };
    expect(call.expiresAt.getTime() - call.removedAt.getTime()).toBe(30 * 60 * 1000);
  });

  it('writes the record after the membership write and before the stats recompute', async () => {
    const { db, logger, order } = makeAdapters();

    await removeFileFromDataLake(actor, 'lake1', 'f1', { db, logger });

    expect(order).toEqual(['pullTagsByFabFileId', 'upsertRemoval', 'computeDataLakeStats']);
  });

  it('a DELETE that 404s (non-member) writes no record and never reaches the recompute', async () => {
    const { db, logger } = makeAdapters({ fileById: { id: 'f1', userId: 'owner', tags: [] } });

    await expect(removeFileFromDataLake(actor, 'lake1', 'f1', { db, logger })).rejects.toThrow(
      /not found in this data lake/i
    );

    expect(db.lakeMembershipRemovals.upsertRemoval).not.toHaveBeenCalled();
    expect(db.fabFiles.computeDataLakeStats).not.toHaveBeenCalled();
  });

  it('a throwing record write is warned and swallowed, and the stats recompute still runs', async () => {
    const { db, logger } = makeAdapters();
    db.lakeMembershipRemovals.upsertRemoval.mockRejectedValue(new Error('boom'));

    const result = await removeFileFromDataLake(actor, 'lake1', 'f1', { db, logger });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/restore record failed to write/i),
      expect.objectContaining({ dataLakeId: 'lake1', fabFileId: 'f1' })
    );
    expect(db.fabFiles.computeDataLakeStats).toHaveBeenCalled();
    expect(result).toEqual({ success: true, fileCount: 0, totalSizeBytes: 0, totalChunkedChars: 0 });
  });
});
