import { describe, it, expect, beforeEach, Mock, vi } from 'vitest';
import { update } from './update';
import {
  DATA_LAKES,
  IDataLakeDocument,
  IDataLakeRepository,
  IFabFileRepository,
  ITagRepository,
  IUserDocument,
} from '@bike4mind/common';

describe('tagService - update', () => {
  const userId = 'test-user-123';
  const existingTagId = 'existing-tag-123';
  type TagRepo = Pick<ITagRepository, 'update' | 'findByIdAndUserId' | 'findAllByUserId' | 'delete'>;
  type FabFileRepo = Pick<
    IFabFileRepository,
    'updateTagsByUserId' | 'dedupeTagByUserId' | 'computeDataLakeStats' | 'claimTagRewriteByUserId'
  >;
  type DataLakeRepo = Pick<IDataLakeRepository, 'find' | 'setStats' | 'activateIfDraft'>;
  type UserRepo = { findById: (id: string) => Promise<Pick<IUserDocument, 'isAdmin'> | null> };
  let mockTagRepo: TagRepo;
  let mockFabFileRepo: FabFileRepo;
  let mockDataLakeRepo: DataLakeRepo;
  let mockUserRepo: UserRepo;
  let adapters: { db: { tags: TagRepo; fabFiles: FabFileRepo; dataLakes: DataLakeRepo; users: UserRepo } };

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
      claimTagRewriteByUserId: vi.fn().mockResolvedValue(null),
      computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount: 0, totalSizeBytes: 0, totalChunkedChars: 0 }),
    };
    mockDataLakeRepo = {
      find: vi.fn().mockResolvedValue([]),
      setStats: vi.fn(),
      activateIfDraft: vi.fn(),
    };
    mockUserRepo = {
      findById: vi.fn().mockResolvedValue({ isAdmin: false }),
    };
    adapters = {
      db: {
        tags: mockTagRepo,
        fabFiles: mockFabFileRepo,
        dataLakes: mockDataLakeRepo,
        users: mockUserRepo,
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

    // 'opti:' is the hardcoded opti-knowledge entry in DATA_LAKES - a static registry lake with
    // no owning document, so no manage-rights gate elsewhere in this file can see it.
    it('refuses a non-admin renaming an ordinary tag INTO a static-registry prefix', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'reports' }));

      await expect(update(userId, { id: existingTagId, name: 'opti:report' }, adapters)).rejects.toThrow(
        "Only an admin can change this data lake's files"
      );
      expect(mockFabFileRepo.updateTagsByUserId).not.toHaveBeenCalled();
      expect(mockTagRepo.update).not.toHaveBeenCalled();
    });

    it('allows an admin to rename an ordinary tag into a static-registry prefix', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'reports' }));
      (mockUserRepo.findById as Mock).mockResolvedValueOnce({ isAdmin: true });

      await update(userId, { id: existingTagId, name: 'opti:report' }, adapters);

      expect(mockFabFileRepo.updateTagsByUserId).toHaveBeenCalledWith(userId, 'reports', 'opti:report');
    });

    it('allows a non-admin to rename AWAY from a legacy static-registry-prefixed tag', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'opti:legacy' }));

      await update(userId, { id: existingTagId, name: 'harmless' }, adapters);

      expect(mockFabFileRepo.updateTagsByUserId).toHaveBeenCalledWith(userId, 'opti:legacy', 'harmless');
    });

    // The gate must key on the DESTINATION alone: an earlier version skipped the check whenever
    // the OLD name was already registry-prefixed, which let a non-admin launder a case-variant
    // file tag (invisible to every apply-time gate) into the canonical, read-arm-matching name by
    // renaming from one registry name to another - the "already there" old name never actually
    // left the namespace.
    it('refuses a non-admin renaming FROM one static-registry-prefixed tag TO another', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'opti:legacy' }));

      await expect(update(userId, { id: existingTagId, name: 'opti:new' }, adapters)).rejects.toThrow(
        "Only an admin can change this data lake's files"
      );
      expect(mockFabFileRepo.updateTagsByUserId).not.toHaveBeenCalled();
      expect(mockTagRepo.update).not.toHaveBeenCalled();
    });

    it('does not check admin status for an edit that never touches a registry prefix', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'reports' }));

      await update(userId, { id: existingTagId, name: 'archived' }, adapters);

      expect(mockUserRepo.findById).not.toHaveBeenCalled();
    });
  });

  describe('renaming a tag that is a lake prefix-arm signal', () => {
    it('recomputes stats for a lake whose prefix the OLD name matches (a possible leave)', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'lk:invoices' }));
      (mockDataLakeRepo.find as Mock).mockResolvedValueOnce([lake()]);

      await update(userId, { id: existingTagId, name: 'archived' }, adapters);

      expect(mockDataLakeRepo.find).toHaveBeenCalledWith({ createdByUserId: { $in: [userId] } });
      expect(mockDataLakeRepo.setStats).toHaveBeenCalledWith('lake1', {
        fileCount: 0,
        totalSizeBytes: 0,
        totalChunkedChars: 0,
      });
    });

    it('recomputes stats for a lake whose prefix the NEW name matches (a possible join)', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'archived' }));
      (mockDataLakeRepo.find as Mock).mockResolvedValueOnce([lake()]);

      await update(userId, { id: existingTagId, name: 'lk:invoices' }, adapters);

      expect(mockDataLakeRepo.setStats).toHaveBeenCalledWith('lake1', {
        fileCount: 0,
        totalSizeBytes: 0,
        totalChunkedChars: 0,
      });
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

  /**
   * `assertWriteScope` is API-KEY SCOPE, a separate axis from the manage-rights gate above: this
   * service only ever touches files `userId` owns, so no manage-rights check is needed, but a
   * `files:write`-only key should not be able to walk a file into or out of a lake via this path
   * any more than `files/tags/toggle.ts` lets it via a meta-tag. Fired only when a prefix-arm match
   * is actually detected, and BEFORE the file rewrite - this service is not transactional, so a
   * denial must land before any write, not alongside the stats recompute after it.
   */
  describe('API-key write-scope gate on a prefix-arm rename', () => {
    it('calls assertWriteScope before rewriting files when the OLD name matches a lake prefix', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'lk:invoices' }));
      (mockDataLakeRepo.find as Mock).mockResolvedValueOnce([lake()]);
      const assertWriteScope = vi.fn();

      await update(userId, { id: existingTagId, name: 'archived' }, { ...adapters, assertWriteScope });

      expect(assertWriteScope).toHaveBeenCalledTimes(1);
      const gateOrder = assertWriteScope.mock.invocationCallOrder[0];
      const renameOrder = (mockFabFileRepo.updateTagsByUserId as Mock).mock.invocationCallOrder[0];
      expect(gateOrder).toBeLessThan(renameOrder);
    });

    it('calls assertWriteScope when the NEW name matches a lake prefix (a possible join)', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'archived' }));
      (mockDataLakeRepo.find as Mock).mockResolvedValueOnce([lake()]);
      const assertWriteScope = vi.fn();

      await update(userId, { id: existingTagId, name: 'lk:invoices' }, { ...adapters, assertWriteScope });

      expect(assertWriteScope).toHaveBeenCalledTimes(1);
    });

    it('does not call assertWriteScope when neither name matches any prefix', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'foo' }));
      (mockDataLakeRepo.find as Mock).mockResolvedValueOnce([lake()]);
      const assertWriteScope = vi.fn();

      await update(userId, { id: existingTagId, name: 'bar' }, { ...adapters, assertWriteScope });

      expect(assertWriteScope).not.toHaveBeenCalled();
    });

    it('propagates a denial from assertWriteScope before any file is touched', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'lk:invoices' }));
      (mockDataLakeRepo.find as Mock).mockResolvedValueOnce([lake()]);
      const assertWriteScope = vi.fn(() => {
        throw new Error('datalake:write is required');
      });

      await expect(
        update(userId, { id: existingTagId, name: 'archived' }, { ...adapters, assertWriteScope })
      ).rejects.toThrow('datalake:write is required');
      expect(mockFabFileRepo.updateTagsByUserId).not.toHaveBeenCalled();
      expect(mockTagRepo.update).not.toHaveBeenCalled();
    });
  });

  /**
   * The bulk door's own membership log - see tagService/remove.test.ts for why the stats recompute
   * is not a substitute. A rename moves files in BOTH directions: into a lake's prefix is a join,
   * out of it a leave, so the direction comes out of the diff rather than being assumed.
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

    /** See tagService/remove.test.ts: each claimed pre-image is a file this request itself rewrote. */
    const claimQueue = (files: unknown[]) => {
      const pending = [...files];
      return vi.fn(async () => pending.shift() ?? null);
    };

    const renaming = (audit: ReturnType<typeof membershipSpy>, oldName: string, files: unknown[], lakes = [lake()]) => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: oldName }));
      (mockDataLakeRepo.find as Mock).mockResolvedValueOnce(lakes);
      mockFabFileRepo.claimTagRewriteByUserId = claimQueue(files);
      return { db: { ...adapters.db, fabFiles: mockFabFileRepo, ...audit.db } };
    };

    it('records an addition when a rename moves a file INTO a lake prefix', async () => {
      const audit = membershipSpy();
      const withAudit = renaming(audit, 'archived', [fileDoc('file1', ['archived'])]);

      await update(userId, { id: existingTagId, name: 'lk:invoices' }, withAudit);

      expect(mockFabFileRepo.claimTagRewriteByUserId).toHaveBeenCalledWith(userId, 'archived', 'lk:invoices', []);
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ dataLakeId: 'lake1', fabFileId: 'file1', action: 'added', origin: 'person' })
      );
    });

    it('records a removal when a rename moves a file OUT of a lake prefix', async () => {
      const audit = membershipSpy();
      const withAudit = renaming(audit, 'lk:invoices', [fileDoc('file1', ['lk:invoices'])]);

      await update(userId, { id: existingTagId, name: 'archived' }, withAudit);

      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ fabFileId: 'file1', action: 'removed' }));
    });

    // The meta-tag arm still holds the file after the prefix tag is renamed away, so nothing moved.
    it('records nothing for a file that also carries the lake meta-tag', async () => {
      const audit = membershipSpy();
      const withAudit = renaming(audit, 'lk:invoices', [fileDoc('file1', ['lk:invoices', 'datalake:lake'])]);

      await update(userId, { id: existingTagId, name: 'archived' }, withAudit);

      expect(audit.record).not.toHaveBeenCalled();
    });

    it('records one event per lake for a file two candidate lakes hold by the same tag', async () => {
      const audit = membershipSpy();
      const lakes = [lake(), lake({ id: 'lake2', datalakeTag: 'datalake:lake2' })];
      const withAudit = renaming(audit, 'lk:invoices', [fileDoc('file1', ['lk:invoices'])], lakes);

      await update(userId, { id: existingTagId, name: 'archived' }, withAudit);

      expect(audit.record.mock.calls.map(([event]) => event.dataLakeId)).toEqual(['lake1', 'lake2']);
    });

    // Claimed after the bulk rewrite, the old name is gone and the moved files are unrecoverable.
    it('claims the affected files BEFORE the bulk rename rewrite runs', async () => {
      const audit = membershipSpy();
      const withAudit = renaming(audit, 'lk:invoices', [fileDoc('file1', ['lk:invoices'])]);

      await update(userId, { id: existingTagId, name: 'archived' }, withAudit);

      const claimOrder = (mockFabFileRepo.claimTagRewriteByUserId as Mock).mock.invocationCallOrder[0];
      const renameOrder = (mockFabFileRepo.updateTagsByUserId as Mock).mock.invocationCallOrder[0];
      expect(claimOrder).toBeLessThan(renameOrder);
    });

    it('excludes what it has already claimed, so the loop terminates on a case-only rename', async () => {
      const audit = membershipSpy();
      // `LK:` still matches the claim's case-insensitive filter after the rewrite, so without the
      // exclusion the same file would be claimed forever.
      const withAudit = renaming(audit, 'lk:invoices', [fileDoc('file1', ['lk:invoices'])]);

      await update(userId, { id: existingTagId, name: 'LK:invoices' }, withAudit);

      const calls = (mockFabFileRepo.claimTagRewriteByUserId as Mock).mock.calls.map(([, , , exclude]) => exclude);
      expect(calls).toEqual([[], ['file1']]);
    });

    // The whole point of claiming rather than snapshotting: the request that loses the race wins
    // no files, so it appends nothing and the history holds one transition per file, not two.
    it('records nothing for the losing half of two concurrent renames', async () => {
      const audit = membershipSpy();
      const withAudit = renaming(audit, 'lk:invoices', []);

      await update(userId, { id: existingTagId, name: 'archived' }, withAudit);

      expect(mockFabFileRepo.claimTagRewriteByUserId).toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    // A registry lake has no document, so the owner-anchored candidate query cannot reach it -
    // but renaming a tag out of its open prefix arm is a real leave.
    it('records a leave from a static registry lake the candidate query cannot return', async () => {
      const audit = membershipSpy();
      const registryTag = `${DATA_LAKES[0].fileTagPrefix}handbook`;
      const withAudit = renaming(audit, registryTag, [fileDoc('file1', [registryTag])], []);

      await update(userId, { id: existingTagId, name: 'archived' }, withAudit);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ dataLakeId: DATA_LAKES[0].id, fabFileId: 'file1', action: 'removed' })
      );
    });

    it('is a silent no-op when no audit repository is wired', async () => {
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'lk:invoices' }));
      (mockDataLakeRepo.find as Mock).mockResolvedValueOnce([lake()]);
      mockFabFileRepo.claimTagRewriteByUserId = claimQueue([fileDoc('file1', ['lk:invoices'])]);

      await expect(
        update(userId, { id: existingTagId, name: 'archived' }, { db: { ...adapters.db, fabFiles: mockFabFileRepo } })
      ).resolves.toBeDefined();
    });

    // Neither side can reach a prefix arm, so the rename cannot move anything and must not pay for
    // the extra writes.
    it('claims nothing when neither name matches any lake prefix', async () => {
      const audit = membershipSpy();
      (mockTagRepo.findByIdAndUserId as Mock).mockResolvedValueOnce(tagDoc({ name: 'foo' }));
      (mockDataLakeRepo.find as Mock).mockResolvedValueOnce([lake()]);

      await update(userId, { id: existingTagId, name: 'bar' }, { db: { ...adapters.db, ...audit.db } });

      expect(mockFabFileRepo.claimTagRewriteByUserId).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});
