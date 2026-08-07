import { describe, it, expect, beforeEach, Mock, vi } from 'vitest';
import { update } from './update';
import { IDataLakeDocument, IDataLakeRepository, IFabFileRepository, ITagRepository } from '@bike4mind/common';

describe('tagService - update', () => {
  const userId = 'test-user-123';
  const existingTagId = 'existing-tag-123';
  type TagRepo = Pick<ITagRepository, 'update' | 'findByIdAndUserId' | 'findAllByUserId' | 'delete'>;
  type FabFileRepo = Pick<IFabFileRepository, 'updateTagsByUserId' | 'dedupeTagByUserId' | 'computeDataLakeStats'>;
  type DataLakeRepo = Pick<IDataLakeRepository, 'find' | 'setStats' | 'activateIfDraft'>;
  let mockTagRepo: TagRepo;
  let mockFabFileRepo: FabFileRepo;
  let mockDataLakeRepo: DataLakeRepo;
  let adapters: { db: { tags: TagRepo; fabFiles: FabFileRepo; dataLakes: DataLakeRepo } };

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

  const tagDoc = (overrides: Record<string, unknown> = {}) => ({
    id: existingTagId,
    userId,
    name: 'Original Name',
    icon: 'folder',
    description: 'Original Description',
    color: '#000000',
    createdAt: new Date(),
    updatedAt: new Date(),
    lastActivityAt: new Date(),
    ...overrides,
  });

  beforeEach(() => {
    mockTagRepo = {
      update: vi.fn(),
      findByIdAndUserId: vi.fn(),
      findAllByUserId: vi.fn().mockResolvedValue([]),
      delete: vi.fn(),
    };
    mockFabFileRepo = {
      updateTagsByUserId: vi.fn().mockResolvedValue(0),
      dedupeTagByUserId: vi.fn().mockResolvedValue(0),
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

  it('should update a tag with partial parameters', async () => {
    // Arrange
    const existingTag = tagDoc();

    const params = {
      id: existingTagId,
      name: 'Updated Name',
      description: 'Updated Description',
    };

    (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(existingTag);
    (mockTagRepo.update as Mock).mockResolvedValueOnce({ ...existingTag, ...params });

    // Act
    const result = await update(userId, params, adapters);

    // Assert
    expect(mockTagRepo.findByIdAndUserId).toHaveBeenCalledWith(existingTagId, userId);
    expect(mockTagRepo.update).toHaveBeenCalledWith({
      id: existingTagId,
      name: 'Updated Name',
      description: 'Updated Description',
      updatedAt: expect.any(Date),
    });
    expect(result).toEqual({
      id: existingTagId,
      name: 'Updated Name',
      description: 'Updated Description',
      updatedAt: expect.any(Date),
    });
  });

  it('should throw an error when tag is not found', async () => {
    // Arrange
    const params = {
      id: 'non-existent-id',
      name: 'Updated Name',
    };

    (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(null);

    // Act & Assert
    await expect(update(userId, params, adapters)).rejects.toThrow('Tag Service - Update: Tag not found');
    expect(mockTagRepo.update).not.toHaveBeenCalled();
    expect(mockFabFileRepo.updateTagsByUserId).not.toHaveBeenCalled();
  });

  it('should update a tag with all optional parameters', async () => {
    // Arrange
    const existingTag = tagDoc();

    const params = {
      id: existingTagId,
      name: 'Updated Name',
      icon: 'folder-open',
      description: 'Updated Description',
      color: '#FF0000',
    };

    (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(existingTag);
    (mockTagRepo.update as Mock).mockResolvedValueOnce({ ...existingTag, ...params });

    // Act
    const result = await update(userId, params, adapters);

    // Assert
    expect(mockTagRepo.findByIdAndUserId).toHaveBeenCalledWith(existingTagId, userId);
    expect(mockTagRepo.update).toHaveBeenCalledWith({
      id: existingTagId,
      name: 'Updated Name',
      icon: 'folder-open',
      description: 'Updated Description',
      color: '#FF0000',
      updatedAt: expect.any(Date),
    });
    expect(result).toEqual({
      id: existingTagId,
      name: 'Updated Name',
      icon: 'folder-open',
      description: 'Updated Description',
      color: '#FF0000',
      updatedAt: expect.any(Date),
    });
  });

  it('should validate input parameters', async () => {
    // Arrange
    const params = {
      id: 123, // Invalid type - should be string
      name: true, // Invalid type - should be string
    };

    // Act & Assert
    // @ts-expect-error Testing invalid types
    await expect(update(userId, params, adapters)).rejects.toThrow('Invalid input: expected string, received number');
  });

  describe('carrying the rename onto the files', () => {
    it('renames the tag on the files, from the stored name to the new one', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'invoices' }));

      await update(userId, { id: existingTagId, name: 'receipts' }, adapters);

      expect(mockFabFileRepo.updateTagsByUserId).toHaveBeenCalledWith(userId, 'invoices', 'receipts');
    });

    // The client PUTs the whole tag, so `name` is present even on a colour-only edit. Touching
    // files on every such request would rewrite the whole collection for a palette change.
    it('touches no files when only the colour changes', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'invoices' }));

      await update(userId, { id: existingTagId, name: 'invoices', color: '#FF0000' }, adapters);

      expect(mockFabFileRepo.updateTagsByUserId).not.toHaveBeenCalled();
      expect(mockFabFileRepo.dedupeTagByUserId).not.toHaveBeenCalled();
      expect(mockTagRepo.update).toHaveBeenCalled();
    });

    // The files store the old casing, so this IS a rename even though the names fold equal.
    it('rewrites the files for a case-only rename', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'invoices' }));

      await update(userId, { id: existingTagId, name: 'Invoices' }, adapters);

      expect(mockFabFileRepo.updateTagsByUserId).toHaveBeenCalledWith(userId, 'invoices', 'Invoices');
    });

    it('trims the incoming name before comparing, so padding alone is not a rename', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'invoices' }));

      await update(userId, { id: existingTagId, name: '  invoices  ' }, adapters);

      expect(mockFabFileRepo.updateTagsByUserId).not.toHaveBeenCalled();
      expect(mockTagRepo.update).toHaveBeenCalledWith(expect.objectContaining({ name: 'invoices' }));
    });

    // Renaming in place leaves two identical entries on any file that already had the target name,
    // whether or not a tag document collided.
    it('de-dupes whenever files moved, even with no colliding tag document', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'invoices' }));
      (mockFabFileRepo.updateTagsByUserId as Mock).mockResolvedValueOnce(3);

      await update(userId, { id: existingTagId, name: 'receipts' }, adapters);

      expect(mockFabFileRepo.dedupeTagByUserId).toHaveBeenCalledWith(userId, 'receipts');
    });

    // Deliberately NOT gated on this call's file count. A previous attempt may have renamed the
    // files and died before de-duping; the retry's rename then matches nothing, and a count-gated
    // de-dupe would skip the duplicate it left behind.
    it('de-dupes even when the rename moved no files, so a retry still clears a stranded duplicate', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'invoices' }));
      (mockFabFileRepo.updateTagsByUserId as Mock).mockResolvedValueOnce(0);

      await update(userId, { id: existingTagId, name: 'receipts' }, adapters);

      expect(mockFabFileRepo.dedupeTagByUserId).toHaveBeenCalledWith(userId, 'receipts');
    });

    // Retry-convergence: if the document write fails, the source still names the old tag, so the
    // same request re-run can still find the stragglers.
    it('rewrites the files BEFORE writing the tag document', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'invoices' }));
      (mockFabFileRepo.updateTagsByUserId as Mock).mockResolvedValueOnce(1);

      await update(userId, { id: existingTagId, name: 'receipts' }, adapters);

      const renameOrder = (mockFabFileRepo.updateTagsByUserId as Mock).mock.invocationCallOrder[0];
      const dedupeOrder = (mockFabFileRepo.dedupeTagByUserId as Mock).mock.invocationCallOrder[0];
      const writeOrder = (mockTagRepo.update as Mock).mock.invocationCallOrder[0];
      expect(renameOrder).toBeLessThan(dedupeOrder);
      expect(dedupeOrder).toBeLessThan(writeOrder);
    });

    it('leaves the tag document naming the old tag when the file rename fails', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'invoices' }));
      (mockFabFileRepo.updateTagsByUserId as Mock).mockRejectedValueOnce(new Error('Database error'));

      await expect(update(userId, { id: existingTagId, name: 'receipts' }, adapters)).rejects.toThrow('Database error');
      expect(mockTagRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('merging onto an existing tag', () => {
    const collider = (id: string, name: string) => ({ ...tagDoc({ name }), id });

    it('deletes the colliding document and keeps the renamed one', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'invoices' }));
      (mockTagRepo.findAllByUserId as Mock).mockResolvedValueOnce([
        tagDoc({ name: 'invoices' }),
        collider('other-tag', 'receipts'),
      ]);

      const result = await update(userId, { id: existingTagId, name: 'receipts' }, adapters);

      expect(mockTagRepo.delete).toHaveBeenCalledWith('other-tag');
      expect(mockTagRepo.delete).toHaveBeenCalledTimes(1);
      // The surviving row keeps the requested id, which is what the client's optimistic update
      // matches on.
      expect(result.id).toBe(existingTagId);
      expect(result.name).toBe('receipts');
    });

    it('collides case-insensitively, matching how the UI decides two tags are the same', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'invoices' }));
      (mockTagRepo.findAllByUserId as Mock).mockResolvedValueOnce([collider('other-tag', 'RECEIPTS')]);

      await update(userId, { id: existingTagId, name: 'receipts' }, adapters);

      expect(mockTagRepo.delete).toHaveBeenCalledWith('other-tag');
    });

    // The unique index has no collation, so `Foo` and `FOO` are two legitimate documents and both
    // must go.
    it('deletes every collider, not just the first', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'invoices' }));
      (mockTagRepo.findAllByUserId as Mock).mockResolvedValueOnce([
        collider('tag-a', 'Receipts'),
        collider('tag-b', 'RECEIPTS'),
      ]);

      await update(userId, { id: existingTagId, name: 'receipts' }, adapters);

      expect(mockTagRepo.delete).toHaveBeenCalledWith('tag-a');
      expect(mockTagRepo.delete).toHaveBeenCalledWith('tag-b');
    });

    it('never deletes the tag being renamed', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'invoices' }));
      (mockTagRepo.findAllByUserId as Mock).mockResolvedValueOnce([tagDoc({ name: 'Invoices' })]);

      await update(userId, { id: existingTagId, name: 'Invoices' }, adapters);

      expect(mockTagRepo.delete).not.toHaveBeenCalled();
    });

    // The unique index would reject the rename while the collider still exists.
    it('deletes the collider BEFORE writing the renamed document', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'invoices' }));
      (mockTagRepo.findAllByUserId as Mock).mockResolvedValueOnce([collider('other-tag', 'receipts')]);

      await update(userId, { id: existingTagId, name: 'receipts' }, adapters);

      const deleteOrder = (mockTagRepo.delete as Mock).mock.invocationCallOrder[0];
      const writeOrder = (mockTagRepo.update as Mock).mock.invocationCallOrder[0];
      expect(deleteOrder).toBeLessThan(writeOrder);
    });

    it('does not look for colliders when nothing is being renamed', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'invoices' }));

      await update(userId, { id: existingTagId, color: '#FF0000' }, adapters);

      expect(mockTagRepo.findAllByUserId).not.toHaveBeenCalled();
      expect(mockTagRepo.delete).not.toHaveBeenCalled();
    });
  });

  describe('guards', () => {
    it('rejects an empty name before touching anything', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'invoices' }));

      await expect(update(userId, { id: existingTagId, name: '   ' }, adapters)).rejects.toThrow();
      expect(mockFabFileRepo.updateTagsByUserId).not.toHaveBeenCalled();
      expect(mockTagRepo.update).not.toHaveBeenCalled();
    });

    // Lake membership IS the tag string on the file, so renaming one would evict every file.
    it('refuses to rename a data lake membership tag', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'datalake:reports' }));

      await expect(update(userId, { id: existingTagId, name: 'reports' }, adapters)).rejects.toThrow(
        'a data lake membership tag cannot be renamed here'
      );
      expect(mockFabFileRepo.updateTagsByUserId).not.toHaveBeenCalled();
      expect(mockTagRepo.update).not.toHaveBeenCalled();
    });

    it('refuses to rename an ordinary tag INTO the data lake namespace', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'reports' }));

      await expect(update(userId, { id: existingTagId, name: 'datalake:reports' }, adapters)).rejects.toThrow(
        'a data lake membership tag cannot be renamed here'
      );
      expect(mockFabFileRepo.updateTagsByUserId).not.toHaveBeenCalled();
      expect(mockTagRepo.update).not.toHaveBeenCalled();
    });

    // The rename matches names case-insensitively, so a case-sensitive guard was walkable in both
    // directions: renaming a `DATALAKE:acme` document rewrites the real membership tag, and
    // renaming an ordinary tag to `DATALAKE:acme` injects files into the lake.
    it.each(['DATALAKE:acme', 'DataLake:acme', '  datalake:acme'])(
      'refuses the membership namespace spelled as %s on the stored name',
      async name => {
        (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name }));

        await expect(update(userId, { id: existingTagId, name: 'harmless' }, adapters)).rejects.toThrow(
          'a data lake membership tag cannot be renamed here'
        );
        expect(mockFabFileRepo.updateTagsByUserId).not.toHaveBeenCalled();
        expect(mockTagRepo.update).not.toHaveBeenCalled();
      }
    );

    it.each(['DATALAKE:acme', 'DataLake:acme'])(
      'refuses the membership namespace spelled as %s on the new name',
      async name => {
        (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'reports' }));

        await expect(update(userId, { id: existingTagId, name }, adapters)).rejects.toThrow(
          'a data lake membership tag cannot be renamed here'
        );
        expect(mockFabFileRepo.updateTagsByUserId).not.toHaveBeenCalled();
        expect(mockTagRepo.update).not.toHaveBeenCalled();
      }
    );
  });

  describe('renaming a tag that is a lake prefix-arm signal', () => {
    it('recomputes stats for a lake whose prefix the OLD name matches (a possible leave)', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'lk:invoices' }));
      (mockDataLakeRepo.find as Mock).mockResolvedValueOnce([lake()]);

      await update(userId, { id: existingTagId, name: 'archived' }, adapters);

      expect(mockDataLakeRepo.find).toHaveBeenCalledWith({ createdByUserId: userId });
      expect(mockDataLakeRepo.setStats).toHaveBeenCalledWith('lake1', { fileCount: 0, totalSizeBytes: 0 });
    });

    it('recomputes stats for a lake whose prefix the NEW name matches (a possible join)', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'archived' }));
      (mockDataLakeRepo.find as Mock).mockResolvedValueOnce([lake()]);

      await update(userId, { id: existingTagId, name: 'lk:invoices' }, adapters);

      expect(mockDataLakeRepo.setStats).toHaveBeenCalledWith('lake1', { fileCount: 0, totalSizeBytes: 0 });
    });

    it('does not recompute when neither the old nor the new name matches any prefix', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'foo' }));
      (mockDataLakeRepo.find as Mock).mockResolvedValueOnce([lake()]);

      await update(userId, { id: existingTagId, name: 'bar' }, adapters);

      expect(mockDataLakeRepo.setStats).not.toHaveBeenCalled();
    });

    it('issues no dataLakes.find call when neither name has a colon', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'foo' }));

      await update(userId, { id: existingTagId, name: 'bar' }, adapters);

      expect(mockDataLakeRepo.find).not.toHaveBeenCalled();
    });

    it('skips the lookup entirely for a non-renaming edit (icon/colour only)', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'lk:invoices' }));

      await update(userId, { id: existingTagId, name: 'lk:invoices', color: '#FF0000' }, adapters);

      expect(mockDataLakeRepo.find).not.toHaveBeenCalled();
    });

    it('renames the files before recomputing, so the recompute sees the write', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'lk:invoices' }));
      (mockDataLakeRepo.find as Mock).mockResolvedValueOnce([lake()]);

      await update(userId, { id: existingTagId, name: 'archived' }, adapters);

      const renameOrder = (mockFabFileRepo.updateTagsByUserId as Mock).mock.invocationCallOrder[0];
      const recomputeOrder = (mockDataLakeRepo.setStats as Mock).mock.invocationCallOrder[0];
      expect(renameOrder).toBeLessThan(recomputeOrder);
    });
  });
});
