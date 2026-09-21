import { describe, it, expect, beforeEach, Mock, vi } from 'vitest';
import { remove } from './remove';
import {
  DATA_LAKES,
  IDataLakeDocument,
  IDataLakeRepository,
  IFabFileRepository,
  ITagRepository,
} from '@bike4mind/common';

describe('tagService - remove', () => {
  const userId = 'test-user-123';
  const existingTagId = 'existing-tag-123';
  let mockTagRepo: Pick<ITagRepository, 'findByIdAndUserId' | 'delete'>;
  let mockFabFileRepo: Pick<
    IFabFileRepository,
    'removeTagByUserId' | 'computeDataLakeStats' | 'claimTagRewriteByUserId'
  >;
  let mockDataLakeRepo: Pick<IDataLakeRepository, 'find' | 'setStats' | 'activateIfDraft'>;
  let adapters: {
    db: {
      tags: Pick<ITagRepository, 'findByIdAndUserId' | 'delete'>;
      fabFiles: typeof mockFabFileRepo;
      dataLakes: typeof mockDataLakeRepo;
    };
  };

  const tagDoc = (name: string) => ({
    id: existingTagId,
    userId,
    name,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastActivityAt: new Date(),
  });

  const lake = (overrides: Partial<IDataLakeDocument> = {}): IDataLakeDocument =>
    ({
      id: 'lake1',
      name: 'Lake',
      slug: 'lake',
      fileTagPrefix: 'lk:',
      datalakeTag: 'datalake:lake',
      createdByUserId: userId,
      status: 'active',
      ...overrides,
    }) as IDataLakeDocument;

  beforeEach(() => {
    mockTagRepo = {
      delete: vi.fn(),
      findByIdAndUserId: vi.fn(),
    };
    mockFabFileRepo = {
      removeTagByUserId: vi.fn().mockResolvedValue(0),
      claimTagRewriteByUserId: vi.fn().mockResolvedValue(null),
      computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 0, totalSizeBytes: 0, totalChunkedChars: 0 }),
    };
    mockDataLakeRepo = {
      find: vi.fn().mockResolvedValue([]),
      setStats: vi.fn(),
      activateIfDraft: vi.fn(),
    };
    adapters = {
      db: {
        tags: mockTagRepo,
        fabFiles: mockFabFileRepo,
        dataLakes: mockDataLakeRepo,
      },
    };
  });

  it('should successfully delete an existing tag', async () => {
    // Arrange
    const params = {
      id: existingTagId,
    };

    (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc('Test Tag'));
    (mockTagRepo.delete as Mock).mockResolvedValueOnce(undefined);

    // Act
    await remove(userId, params, adapters);

    // Assert
    expect(mockTagRepo.findByIdAndUserId).toHaveBeenCalledWith(existingTagId, userId);
    expect(mockTagRepo.delete).toHaveBeenCalledWith(existingTagId);
  });

  it('should throw an error when tag is not found', async () => {
    // Arrange
    const params = {
      id: 'non-existent-id',
    };

    (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(null);

    // Act & Assert
    await expect(remove(userId, params, adapters)).rejects.toThrow('Tag Service - Delete: Tag not found');
    expect(mockTagRepo.delete).not.toHaveBeenCalled();
  });

  it('should validate input parameters', async () => {
    // Arrange
    const params = {
      id: 123, // Invalid type - should be string
    };

    // Act & Assert
    // @ts-expect-error Testing invalid types
    await expect(remove(userId, params, adapters)).rejects.toThrow('Invalid input: expected string, received number');
  });

  it('should handle delete operation failure', async () => {
    // Arrange
    const params = {
      id: existingTagId,
    };

    (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc('Test Tag'));
    (mockTagRepo.delete as Mock).mockRejectedValueOnce(new Error('Database error'));

    // Act & Assert
    await expect(remove(userId, params, adapters)).rejects.toThrow('Database error');
    expect(mockTagRepo.findByIdAndUserId).toHaveBeenCalledWith(existingTagId, userId);
    expect(mockTagRepo.delete).toHaveBeenCalledWith(existingTagId);
  });

  it('strips the name off the files, using the STORED name rather than anything from the request', async () => {
    (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc('Invoices'));
    (mockFabFileRepo.removeTagByUserId as Mock).mockResolvedValueOnce(4);

    const result = await remove(userId, { id: existingTagId }, adapters);

    expect(mockFabFileRepo.removeTagByUserId).toHaveBeenCalledWith(userId, 'Invoices');
    expect(result).toEqual({ id: existingTagId, name: 'Invoices', filesUpdated: 4 });
  });

  // The order is the correctness argument: deleting the document first strands the files, because
  // the name that would locate them is gone.
  it('strips the files BEFORE deleting the tag document', async () => {
    (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc('Invoices'));

    await remove(userId, { id: existingTagId }, adapters);

    const stripOrder = (mockFabFileRepo.removeTagByUserId as Mock).mock.invocationCallOrder[0];
    const deleteOrder = (mockTagRepo.delete as Mock).mock.invocationCallOrder[0];
    expect(stripOrder).toBeLessThan(deleteOrder);
  });

  it('leaves the tag document in place when the file strip fails, so the delete can be retried', async () => {
    (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc('Invoices'));
    (mockFabFileRepo.removeTagByUserId as Mock).mockRejectedValueOnce(new Error('Database error'));

    await expect(remove(userId, { id: existingTagId }, adapters)).rejects.toThrow('Database error');
    expect(mockTagRepo.delete).not.toHaveBeenCalled();
  });

  it('does not strip files when the tag is not found', async () => {
    (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(null);

    await expect(remove(userId, { id: 'missing' }, adapters)).rejects.toThrow();
    expect(mockFabFileRepo.removeTagByUserId).not.toHaveBeenCalled();
  });

  // Lake membership IS the tag string on the file, so stripping one would evict every file from
  // the lake. Such a document is reachable: accepting an invite to a shared lake file mints one.
  it('refuses a data lake membership tag before touching anything', async () => {
    (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc('datalake:quarterly-reports'));

    await expect(remove(userId, { id: existingTagId }, adapters)).rejects.toThrow(
      'a data lake membership tag cannot be deleted here'
    );
    expect(mockFabFileRepo.removeTagByUserId).not.toHaveBeenCalled();
    expect(mockTagRepo.delete).not.toHaveBeenCalled();
  });

  // The strip matches names case-insensitively, so a case-sensitive guard was walkable: create a
  // `DATALAKE:acme` document (nothing refuses that at create time), delete it, and the strip pulls
  // the real `datalake:acme` membership off every file the caller owns.
  it.each(['DATALAKE:acme', 'DataLake:acme', '  datalake:acme'])(
    'refuses the membership namespace spelled as %s',
    async name => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc(name));

      await expect(remove(userId, { id: existingTagId }, adapters)).rejects.toThrow(
        'a data lake membership tag cannot be deleted here'
      );
      expect(mockFabFileRepo.removeTagByUserId).not.toHaveBeenCalled();
      expect(mockTagRepo.delete).not.toHaveBeenCalled();
    }
  );

  describe('deleting a tag that is a lake prefix-arm signal', () => {
    it('recomputes stats for a lake whose prefix the deleted tag matches', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc('lk:invoices'));
      (mockDataLakeRepo.find as Mock).mockResolvedValueOnce([lake()]);

      await remove(userId, { id: existingTagId }, adapters);

      expect(mockDataLakeRepo.find).toHaveBeenCalledWith({ createdByUserId: { $in: [userId] } });
      expect(mockFabFileRepo.computeDataLakeStats).toHaveBeenCalled();
      expect(mockDataLakeRepo.setStats).toHaveBeenCalledWith('lake1', {
        fileCount: 0,
        totalSizeBytes: 0,
        totalChunkedChars: 0,
      });
    });

    it('does not recompute a lake whose prefix the deleted tag does not match', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc('unrelated:tag'));
      (mockDataLakeRepo.find as Mock).mockResolvedValueOnce([lake()]);

      await remove(userId, { id: existingTagId }, adapters);

      expect(mockDataLakeRepo.setStats).not.toHaveBeenCalled();
    });

    it('runs the bulk strip before recomputing, so the recompute sees the write', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc('lk:invoices'));
      (mockDataLakeRepo.find as Mock).mockResolvedValueOnce([lake()]);

      await remove(userId, { id: existingTagId }, adapters);

      const stripOrder = (mockFabFileRepo.removeTagByUserId as Mock).mock.invocationCallOrder[0];
      const recomputeOrder = (mockDataLakeRepo.setStats as Mock).mock.invocationCallOrder[0];
      expect(stripOrder).toBeLessThan(recomputeOrder);
    });

    // removeTagByUserId strips a stored name case-INSENSITIVELY, so a mixed-case tag document can
    // still be the thing that clears a lake's real (correctly-cased) signal tag off some file.
    // A case-sensitive recompute trigger would miss that and leave fileCount stale.
    it('recomputes stats for a lake whose prefix the deleted tag matches only case-insensitively', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc('LK:Invoices'));
      (mockDataLakeRepo.find as Mock).mockResolvedValueOnce([lake()]);

      await remove(userId, { id: existingTagId }, adapters);

      expect(mockDataLakeRepo.setStats).toHaveBeenCalledWith('lake1', {
        fileCount: 0,
        totalSizeBytes: 0,
        totalChunkedChars: 0,
      });
    });

    it('issues no dataLakes.find call when the tag name has no colon', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc('plain'));

      await remove(userId, { id: existingTagId }, adapters);

      expect(mockDataLakeRepo.find).not.toHaveBeenCalled();
    });

    it('queries lakes scoped to this userId, so another user cannot be affected', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc('lk:invoices'));
      (mockDataLakeRepo.find as Mock).mockResolvedValueOnce([]);

      await remove(userId, { id: existingTagId }, adapters);

      expect(mockDataLakeRepo.find).toHaveBeenCalledWith({ createdByUserId: { $in: [userId] } });
      expect(mockDataLakeRepo.setStats).not.toHaveBeenCalled();
    });
  });

  /**
   * `assertWriteScope` is API-KEY SCOPE, a separate axis from the manage-rights reasoning above:
   * this service only ever touches files `userId` owns, so no manage-rights check is needed, but a
   * `files:write`-only key should not be able to walk a file out of a lake via this path any more
   * than `files/tags/toggle.ts` lets it via a meta-tag. Fired only when a prefix-arm match is
   * detected, and BEFORE the strip - not transactional, so a denial must land before any write.
   */
  describe('API-key write-scope gate on a prefix-arm delete', () => {
    it('calls assertWriteScope before stripping files when the deleted tag matches a lake prefix', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc('lk:invoices'));
      (mockDataLakeRepo.find as Mock).mockResolvedValueOnce([lake()]);
      const assertWriteScope = vi.fn();

      await remove(userId, { id: existingTagId }, { ...adapters, assertWriteScope });

      expect(assertWriteScope).toHaveBeenCalledTimes(1);
      const gateOrder = assertWriteScope.mock.invocationCallOrder[0];
      const stripOrder = (mockFabFileRepo.removeTagByUserId as Mock).mock.invocationCallOrder[0];
      expect(gateOrder).toBeLessThan(stripOrder);
    });

    it('does not call assertWriteScope when the deleted tag matches no lake prefix', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc('unrelated:tag'));
      (mockDataLakeRepo.find as Mock).mockResolvedValueOnce([lake()]);
      const assertWriteScope = vi.fn();

      await remove(userId, { id: existingTagId }, { ...adapters, assertWriteScope });

      expect(assertWriteScope).not.toHaveBeenCalled();
    });

    it('propagates a denial from assertWriteScope before any file is touched', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc('lk:invoices'));
      (mockDataLakeRepo.find as Mock).mockResolvedValueOnce([lake()]);
      const assertWriteScope = vi.fn(() => {
        throw new Error('datalake:write is required');
      });

      await expect(remove(userId, { id: existingTagId }, { ...adapters, assertWriteScope })).rejects.toThrow(
        'datalake:write is required'
      );
      expect(mockFabFileRepo.removeTagByUserId).not.toHaveBeenCalled();
      expect(mockTagRepo.delete).not.toHaveBeenCalled();
    });
  });

  /**
   * The bulk door's own membership log. The stats recompute above is an approximation - it
   * re-derives a count - but this log is what a reader reconstructs MEMBERSHIP from, so it has to
   * name the exact (lake, file) pairs that moved. Without it, deleting a lake's prefix tag walked
   * every prefix-only file out of that lake leaving no trace at all.
   */
  describe('membership change log', () => {
    const membershipSpy = () => {
      const record = vi.fn().mockResolvedValue({});
      return { db: { lakeMembershipChangeEvents: { record } }, record };
    };

    const fileDoc = (id: string, tagNames: string[]) => ({
      id,
      userId,
      tags: tagNames.map(name => ({ name, strength: 0.5 })),
    });

    /**
     * The claim loop's shape: the door keeps claiming until the repository reports nothing left,
     * and each claimed pre-image is a file THIS request's own write rewrote. A file the door never
     * wins simply never appears - which is how the losing half of two concurrent deletes records
     * nothing.
     */
    const claimQueue = (files: unknown[]) => {
      const pending = [...files];
      return vi.fn(async () => pending.shift() ?? null);
    };

    const deletingTag = (audit: ReturnType<typeof membershipSpy>, name: string, files: unknown[], lakes = [lake()]) => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc(name));
      (mockDataLakeRepo.find as Mock).mockResolvedValueOnce(lakes);
      mockFabFileRepo.claimTagRewriteByUserId = claimQueue(files);
      return { db: { ...adapters.db, fabFiles: mockFabFileRepo, ...audit.db } };
    };

    const deletingPrefixTag = (audit: ReturnType<typeof membershipSpy>, files: unknown[], lakes = [lake()]) =>
      deletingTag(audit, 'lk:invoices', files, lakes);

    it('records one removal naming the lake and the file a prefix-only member leaves', async () => {
      const audit = membershipSpy();

      await remove(userId, { id: existingTagId }, deletingPrefixTag(audit, [fileDoc('file1', ['lk:invoices'])]));

      expect(mockFabFileRepo.claimTagRewriteByUserId).toHaveBeenCalledWith(userId, 'lk:invoices', null, []);
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          dataLakeId: 'lake1',
          fabFileId: 'file1',
          action: 'removed',
          origin: 'person',
          principalKind: 'user',
          principalId: userId,
        })
      );
    });

    // The meta-tag arm still holds this file, so its membership never flipped. A prefix-only diff
    // would report a leave that did not happen.
    it('records nothing for a file that also carries the lake meta-tag', async () => {
      const audit = membershipSpy();

      await remove(
        userId,
        { id: existingTagId },
        deletingPrefixTag(audit, [fileDoc('file1', ['lk:invoices', 'datalake:lake'])])
      );

      expect(audit.record).not.toHaveBeenCalled();
    });

    it('records one removal per lake for a file two candidate lakes hold by the same tag', async () => {
      const audit = membershipSpy();
      const lakes = [lake(), lake({ id: 'lake2', datalakeTag: 'datalake:lake2' })];

      await remove(userId, { id: existingTagId }, deletingPrefixTag(audit, [fileDoc('file1', ['lk:invoices'])], lakes));

      expect(audit.record.mock.calls.map(([event]) => event.dataLakeId)).toEqual(['lake1', 'lake2']);
    });

    // Claimed after the bulk strip, the name is gone and the leaving files are unrecoverable.
    it('claims the affected files BEFORE the bulk strip runs', async () => {
      const audit = membershipSpy();

      await remove(userId, { id: existingTagId }, deletingPrefixTag(audit, [fileDoc('file1', ['lk:invoices'])]));

      const claimOrder = (mockFabFileRepo.claimTagRewriteByUserId as Mock).mock.invocationCallOrder[0];
      const stripOrder = (mockFabFileRepo.removeTagByUserId as Mock).mock.invocationCallOrder[0];
      expect(claimOrder).toBeLessThan(stripOrder);
    });

    it('excludes what it has already claimed, so the loop terminates on a repeated match', async () => {
      const audit = membershipSpy();

      await remove(
        userId,
        { id: existingTagId },
        deletingPrefixTag(audit, [fileDoc('file1', ['lk:invoices']), fileDoc('file2', ['lk:invoices'])])
      );

      const calls = (mockFabFileRepo.claimTagRewriteByUserId as Mock).mock.calls.map(([, , , exclude]) => exclude);
      expect(calls).toEqual([[], ['file1'], ['file1', 'file2']]);
    });

    // The whole point of claiming rather than snapshotting: the request that loses the race wins
    // no files, so it appends nothing and the history holds one leave per file, not two.
    it('records nothing for the losing half of two concurrent deletes', async () => {
      const audit = membershipSpy();

      await remove(userId, { id: existingTagId }, deletingPrefixTag(audit, []));

      expect(mockFabFileRepo.claimTagRewriteByUserId).toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    // A registry lake has no document, so the owner-anchored candidate query cannot reach it -
    // but its open prefix arm is real membership and losing the tag is a real leave.
    it('records a leave from a static registry lake the candidate query cannot return', async () => {
      const audit = membershipSpy();

      await remove(
        userId,
        { id: existingTagId },
        deletingTag(
          audit,
          `${DATA_LAKES[0].fileTagPrefix}handbook`,
          [fileDoc('file1', [`${DATA_LAKES[0].fileTagPrefix}handbook`])],
          []
        )
      );

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ dataLakeId: DATA_LAKES[0].id, fabFileId: 'file1', action: 'removed' })
      );
    });

    it('is a silent no-op when no audit repository is wired', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc('lk:invoices'));
      (mockDataLakeRepo.find as Mock).mockResolvedValueOnce([lake()]);
      mockFabFileRepo.claimTagRewriteByUserId = claimQueue([fileDoc('file1', ['lk:invoices'])]);

      await expect(
        remove(userId, { id: existingTagId }, { db: { ...adapters.db, fabFiles: mockFabFileRepo } })
      ).resolves.toBeDefined();
    });

    // The common plain-tag delete must not pay for an audit trail it can never populate.
    it('claims nothing when the deleted tag matches no lake prefix', async () => {
      const audit = membershipSpy();
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc('unrelated:tag'));
      (mockDataLakeRepo.find as Mock).mockResolvedValueOnce([lake()]);

      await remove(userId, { id: existingTagId }, { db: { ...adapters.db, ...audit.db } });

      expect(mockFabFileRepo.claimTagRewriteByUserId).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});
