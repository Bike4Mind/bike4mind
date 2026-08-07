import { describe, it, expect, beforeEach, Mock, vi } from 'vitest';
import { remove } from './remove';
import { IFabFileRepository, ITagRepository } from '@bike4mind/common';

describe('tagService - remove', () => {
  const userId = 'test-user-123';
  const existingTagId = 'existing-tag-123';
  let mockTagRepo: Pick<ITagRepository, 'findByIdAndUserId' | 'delete'>;
  let mockFabFileRepo: Pick<IFabFileRepository, 'removeTagByUserId'>;
  let adapters: {
    db: {
      tags: Pick<ITagRepository, 'findByIdAndUserId' | 'delete'>;
      fabFiles: Pick<IFabFileRepository, 'removeTagByUserId'>;
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

  beforeEach(() => {
    mockTagRepo = {
      delete: vi.fn(),
      findByIdAndUserId: vi.fn(),
    };
    mockFabFileRepo = {
      removeTagByUserId: vi.fn().mockResolvedValue(0),
    };
    adapters = {
      db: {
        tags: mockTagRepo,
        fabFiles: mockFabFileRepo,
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
});
