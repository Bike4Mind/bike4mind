import { describe, it, expect, beforeEach, Mock, vi } from 'vitest';
import { remove } from './remove';
import { IDataLakeDocument, IDataLakeRepository, IFabFileRepository, ITagRepository } from '@bike4mind/common';

describe('tagService - remove', () => {
  const userId = 'test-user-123';
  const existingTagId = 'existing-tag-123';
  let mockTagRepo: Pick<ITagRepository, 'findByIdAndUserId' | 'delete'>;
  let mockFabFileRepo: Pick<IFabFileRepository, 'removeTagByUserId' | 'computeDataLakeStats'>;
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
      computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 0, totalSizeBytes: 0 }),
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
      expect(mockDataLakeRepo.setStats).toHaveBeenCalledWith('lake1', { fileCount: 0, totalSizeBytes: 0 });
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

      expect(mockDataLakeRepo.setStats).toHaveBeenCalledWith('lake1', { fileCount: 0, totalSizeBytes: 0 });
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
});
