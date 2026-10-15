import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { UnauthorizedError } from '@bike4mind/utils';
import { deleteFabFile } from './delete';
import { DATA_LAKES, IFabFileDocument } from '@bike4mind/common';

describe('deleteFabFile', () => {
  const mockUserId = 'user-123';
  const mockFileId = 'file-456';
  const mockOwnerId = 'owner-789';

  const mockFabFile: Partial<IFabFileDocument> = {
    id: mockFileId,
    userId: mockUserId,
    fileName: 'test-file.txt',
    filePath: 'uploads/test-file.txt',
    fileSize: 1024,
    users: [],
  };

  const createMockSharedFile = (): Partial<IFabFileDocument> => ({
    id: mockFileId,
    userId: mockOwnerId,
    fileName: 'shared-file.txt',
    filePath: 'uploads/shared-file.txt',
    fileSize: 2048,
    users: [{ userId: mockUserId, permissions: ['read'] }],
  });

  let mockAdapter: {
    db: {
      fabFiles: {
        findByIdAndUserId: Mock;
        findById: Mock;
        findAllInIds: Mock;
        update: Mock;
        deleteManyInIds: Mock;
      };
      fabFileChunks: {
        deleteManyByFabFileId: Mock;
        distinctRetrievalIndexModelsByFabFileIds: Mock;
      };
      users: {
        findById: Mock;
        update: Mock;
      };
      sessions: {
        findAllWithKnowledgeId: Mock;
        update: Mock;
      };
      dataLakes?: { find: Mock; findByDatalakeTag: Mock };
      lakeMembershipChangeEvents?: { record: Mock };
    };
    storage: {
      delete: Mock;
    };
    onDeleteComplete?: Mock;
    searchIndex?: { deleteByFabFileId: Mock };
    origin?: 'person' | 'connector';
    auditPrincipal?: never;
    logger?: never;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockAdapter = {
      db: {
        fabFiles: {
          findByIdAndUserId: vi.fn(),
          findById: vi.fn(),
          findAllInIds: vi.fn(),
          update: vi.fn(),
          deleteManyInIds: vi.fn(),
        },
        fabFileChunks: {
          deleteManyByFabFileId: vi.fn(),
          distinctRetrievalIndexModelsByFabFileIds: vi.fn().mockResolvedValue([]),
        },
        users: {
          findById: vi.fn().mockResolvedValue({ id: mockUserId }),
          update: vi.fn(),
        },
        sessions: {
          findAllWithKnowledgeId: vi.fn().mockResolvedValue([]),
          update: vi.fn(),
        },
      },
      storage: {
        delete: vi.fn().mockResolvedValue(undefined),
      },
    };
  });

  it('should throw UnauthorizedError when user is not found', async () => {
    mockAdapter.db.users.findById.mockResolvedValue(null);

    await expect(deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter)).rejects.toThrow(UnauthorizedError);
  });

  describe('owned files', () => {
    it('should soft-delete owned file and return action "deleted"', async () => {
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(mockFabFile);
      mockAdapter.db.fabFiles.update.mockResolvedValue(mockFabFile);

      const result = await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      expect(result.action).toBe('deleted');
      expect(result.fabFile).toBe(mockFabFile);
      expect(mockAdapter.db.fabFiles.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: mockFileId, deletedAt: expect.any(Date) })
      );
      expect(mockAdapter.db.fabFileChunks.deleteManyByFabFileId).toHaveBeenCalledWith(mockFileId);
      expect(mockAdapter.storage.delete).toHaveBeenCalledWith('uploads/test-file.txt');
    });

    it('should call onDeleteComplete with correct size when file has fileSize', async () => {
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(mockFabFile);
      mockAdapter.db.fabFiles.update.mockResolvedValue(mockFabFile);
      mockAdapter.onDeleteComplete = vi.fn().mockResolvedValue(undefined);

      await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      expect(mockAdapter.onDeleteComplete).toHaveBeenCalledWith(mockFabFile, 1024);
    });

    it("also removes a generated file's inline-playback copy from the generated bucket", async () => {
      const generatedFile = { ...mockFabFile, sourceMetadata: { sessionId: 's1', generatedCopyKey: 'abc.mp3' } };
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(generatedFile);
      mockAdapter.db.fabFiles.update.mockResolvedValue(generatedFile);
      const generatedCopies = {
        storage: { delete: vi.fn().mockResolvedValue(undefined) },
        quests: { findSessionIdsByImage: vi.fn().mockResolvedValue(['s1']) },
      };

      await deleteFabFile(mockUserId, { id: mockFileId }, { ...mockAdapter, generatedCopies });

      expect(mockAdapter.storage.delete).toHaveBeenCalledWith('uploads/test-file.txt');
      expect(generatedCopies.storage.delete).toHaveBeenCalledWith('abc.mp3');
    });

    // Ownership is resolved by findByIdAndUserId, whose whole document is what feeds the stored-object
    // delete - so these pin the field the legal-hold rule reads, not just the row.
    describe('moderation hold', () => {
      it('frees the bytes of a file blocked only for an unscannable format', async () => {
        const blocked = { ...mockFabFile, moderationStatus: 'blocked', blockReason: 'unsupported_format' };
        mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(blocked);
        mockAdapter.db.fabFiles.update.mockResolvedValue(blocked);

        await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

        expect(mockAdapter.storage.delete).toHaveBeenCalledWith('uploads/test-file.txt');
      });

      it('keeps the bytes of a content block as legal-hold evidence', async () => {
        const blocked = { ...mockFabFile, moderationStatus: 'blocked' };
        mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(blocked);
        mockAdapter.db.fabFiles.update.mockResolvedValue(blocked);

        await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

        expect(mockAdapter.storage.delete).not.toHaveBeenCalled();
      });
    });

    it('should skip S3 deletion when file has no filePath', async () => {
      const fileWithoutPath = { ...mockFabFile, filePath: undefined, fileSize: 0 };
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(fileWithoutPath);
      mockAdapter.db.fabFiles.update.mockResolvedValue(fileWithoutPath);

      await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      expect(mockAdapter.storage.delete).not.toHaveBeenCalled();
    });

    it('deletes every distinct version key, then the current filePath', async () => {
      const v = (version: number, filePath: string) => ({
        version,
        filePath,
        fileSize: 1,
        mimeType: 'x',
        createdAt: new Date(0),
      });
      const edited = {
        ...mockFabFile,
        filePath: 'files/u/f/v3_report.docx',
        versions: [
          v(1, 'uploads/report.docx'),
          v(2, 'files/u/f/v2_report.docx'),
          v(2, 'files/u/f/v2_report.docx'),
          v(3, 'files/u/f/v3_report.docx'),
          v(4, ''),
        ],
      };
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(edited);
      mockAdapter.db.fabFiles.update.mockResolvedValue(edited);
      mockAdapter.onDeleteComplete = vi.fn().mockResolvedValue(undefined);

      await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      expect(mockAdapter.storage.delete.mock.calls.map(([key]) => key)).toEqual([
        'uploads/report.docx',
        'files/u/f/v2_report.docx',
        'files/u/f/v3_report.docx',
      ]);
      expect(mockAdapter.onDeleteComplete).toHaveBeenCalledWith(edited, 1024);
    });

    describe('when a storage delete fails for an AI-edited file', () => {
      const v = (version: number, filePath: string) => ({
        version,
        filePath,
        fileSize: 1,
        mimeType: 'x',
        createdAt: new Date(0),
      });
      const edited = () => ({
        ...mockFabFile,
        filePath: 'files/u/f/v3_report.docx',
        versions: [v(1, 'uploads/report.docx'), v(2, 'files/u/f/v2_report.docx'), v(3, 'files/u/f/v3_report.docx')],
      });
      const failOn = (failingKey: string) => {
        const file = edited();
        mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(file);
        mockAdapter.db.fabFiles.update.mockResolvedValue(file);
        mockAdapter.onDeleteComplete = vi.fn().mockResolvedValue(undefined);
        mockAdapter.storage.delete.mockImplementation(async (key: string) => {
          if (key === failingKey) throw new Error('S3 unavailable');
        });
      };

      it('still refunds quota and attempts every key when a retained version fails', async () => {
        failOn('uploads/report.docx');

        await expect(deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter)).resolves.toMatchObject({
          action: 'deleted',
        });

        expect(mockAdapter.storage.delete.mock.calls.map(([key]) => key)).toEqual([
          'uploads/report.docx',
          'files/u/f/v2_report.docx',
          'files/u/f/v3_report.docx',
        ]);
        expect(mockAdapter.onDeleteComplete).toHaveBeenCalledTimes(1);
      });

      it('rejects without a refund when the current filePath fails, after trying the versions', async () => {
        failOn('files/u/f/v3_report.docx');

        await expect(deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter)).rejects.toThrow('S3 unavailable');

        expect(mockAdapter.storage.delete.mock.calls.map(([key]) => key)).toEqual([
          'uploads/report.docx',
          'files/u/f/v2_report.docx',
          'files/u/f/v3_report.docx',
        ]);
        expect(mockAdapter.onDeleteComplete).not.toHaveBeenCalled();
      });
    });

    it('still deletes version keys when the file has no filePath', async () => {
      const noCurrent = {
        ...mockFabFile,
        filePath: undefined,
        fileSize: 0,
        versions: [{ version: 1, filePath: 'uploads/a.docx', fileSize: 1, mimeType: 'x', createdAt: new Date(0) }],
      };
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(noCurrent);
      mockAdapter.db.fabFiles.update.mockResolvedValue(noCurrent);

      await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      expect(mockAdapter.storage.delete.mock.calls.map(([key]) => key)).toEqual(['uploads/a.docx']);
    });

    it('should unlink file from associated sessions', async () => {
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(mockFabFile);
      mockAdapter.db.fabFiles.update.mockResolvedValue(mockFabFile);
      mockAdapter.db.sessions.findAllWithKnowledgeId.mockResolvedValue([
        { id: 'session-1', knowledgeIds: [mockFileId, 'other-file'] },
        { id: 'session-2', knowledgeIds: [mockFileId] },
      ]);

      await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      expect(mockAdapter.db.sessions.update).toHaveBeenCalledWith({
        id: 'session-1',
        knowledgeIds: ['other-file'],
      });
      expect(mockAdapter.db.sessions.update).toHaveBeenCalledWith({
        id: 'session-2',
        knowledgeIds: [],
      });
    });
  });

  describe('searchIndex (self-host OpenSearch mirror)', () => {
    it('resolves every model the file actually used from the chunk store, not just FabFile.embeddingModel, and deletes from each', async () => {
      // A re-embedded file's chunks can span more than one model (see IFabFileChunk.embeddingModel) -
      // FabFile.embeddingModel alone is only the CURRENT one and would miss an earlier index.
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(mockFabFile);
      mockAdapter.db.fabFiles.update.mockResolvedValue(mockFabFile);
      mockAdapter.db.fabFileChunks.distinctRetrievalIndexModelsByFabFileIds.mockResolvedValue([
        'text-embedding-3-small',
        'text-embedding-3-large',
      ]);
      mockAdapter.searchIndex = { deleteByFabFileId: vi.fn().mockResolvedValue(undefined) };

      await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      expect(mockAdapter.db.fabFileChunks.distinctRetrievalIndexModelsByFabFileIds).toHaveBeenCalledWith([mockFileId]);
      expect(mockAdapter.searchIndex.deleteByFabFileId).toHaveBeenCalledTimes(2);
      expect(mockAdapter.searchIndex.deleteByFabFileId).toHaveBeenCalledWith(mockFileId, 'text-embedding-3-small');
      expect(mockAdapter.searchIndex.deleteByFabFileId).toHaveBeenCalledWith(mockFileId, 'text-embedding-3-large');
    });

    it('skips the delete calls (but still resolves models) when the chunk store has no models for this file', async () => {
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(mockFabFile);
      mockAdapter.db.fabFiles.update.mockResolvedValue(mockFabFile);
      mockAdapter.db.fabFileChunks.distinctRetrievalIndexModelsByFabFileIds.mockResolvedValue([]);
      mockAdapter.searchIndex = { deleteByFabFileId: vi.fn() };

      await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      expect(mockAdapter.searchIndex.deleteByFabFileId).not.toHaveBeenCalled();
    });

    it('is a no-op when searchIndex is not provided (non-self-host) - never even queries the chunk store', async () => {
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(mockFabFile);
      mockAdapter.db.fabFiles.update.mockResolvedValue(mockFabFile);

      await expect(deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter)).resolves.toMatchObject({
        action: 'deleted',
      });
      expect(mockAdapter.db.fabFileChunks.distinctRetrievalIndexModelsByFabFileIds).not.toHaveBeenCalled();
    });
  });

  describe('shared files (self-unshare)', () => {
    it('should remove user from share list and return action "unshared"', async () => {
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(null);
      mockAdapter.db.fabFiles.findById.mockResolvedValue(createMockSharedFile());

      const result = await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      expect(result.action).toBe('unshared');
      expect(result.fabFile?.id).toBe(mockFileId);
      expect(mockAdapter.db.fabFiles.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: mockFileId,
          users: [],
        })
      );
      // Should NOT soft-delete or delete S3 objects
      expect(mockAdapter.storage.delete).not.toHaveBeenCalled();
      expect(mockAdapter.db.fabFileChunks.deleteManyByFabFileId).not.toHaveBeenCalled();
    });

    it('should clean up only the unsharing user sessions', async () => {
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(null);
      mockAdapter.db.fabFiles.findById.mockResolvedValue(createMockSharedFile());
      mockAdapter.db.sessions.findAllWithKnowledgeId.mockResolvedValue([
        { id: 'session-1', userId: mockUserId, knowledgeIds: [mockFileId, 'other-file'] },
        { id: 'session-2', userId: mockOwnerId, knowledgeIds: [mockFileId] },
      ]);

      await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      // Only the unsharing user's session should be cleaned up
      expect(mockAdapter.db.sessions.update).toHaveBeenCalledTimes(1);
      expect(mockAdapter.db.sessions.update).toHaveBeenCalledWith({
        id: 'session-1',
        knowledgeIds: ['other-file'],
      });
    });
  });

  describe('file not found', () => {
    it('should return action "not_found" when file does not exist at all', async () => {
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(null);
      mockAdapter.db.fabFiles.findById.mockResolvedValue(null);

      const result = await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      expect(result.action).toBe('not_found');
      expect(result.fabFile).toBeNull();
      expect(mockAdapter.db.fabFiles.update).not.toHaveBeenCalled();
      expect(mockAdapter.storage.delete).not.toHaveBeenCalled();
    });

    it('should return action "denied" when file exists but user is not in share list', async () => {
      const fileNotSharedToUser: Partial<IFabFileDocument> = {
        ...createMockSharedFile(),
        users: [{ userId: 'other-user', permissions: ['read'] }],
      };
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(null);
      mockAdapter.db.fabFiles.findById.mockResolvedValue(fileNotSharedToUser);

      const result = await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      expect(result.action).toBe('denied');
      expect(result.fabFile).toBeNull();
      expect(mockAdapter.db.fabFiles.update).not.toHaveBeenCalled();
    });
  });

  describe('lake membership removed events', () => {
    // A soft delete never calls removeFileFromLake (it only stamps deletedAt and leaves the
    // file's tags in place), so the 'removed' event has to be recorded by this door directly.
    const mockLake = { id: 'lake-1', organizationId: 'org-1' } as never;

    let record: Mock;
    let find: Mock;
    let findByDatalakeTag: Mock;

    beforeEach(() => {
      record = vi.fn().mockResolvedValue(undefined);
      find = vi.fn().mockResolvedValue([]);
      findByDatalakeTag = vi.fn().mockResolvedValue(null);
      mockAdapter.db.dataLakes = { find, findByDatalakeTag };
      mockAdapter.db.lakeMembershipChangeEvents = { record };
    });

    it('records one removed event per member lake on an owned soft delete, defaulting to origin "person"', async () => {
      const fileWithTag = { ...mockFabFile, tags: [{ name: 'datalake:lake-1' }] };
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(fileWithTag);
      mockAdapter.db.fabFiles.update.mockResolvedValue(fileWithTag);
      findByDatalakeTag.mockResolvedValue(mockLake);

      await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ dataLakeId: 'lake-1', fabFileId: mockFileId, action: 'removed', origin: 'person' })
      );
    });

    it('records origin "connector" when the caller says so', async () => {
      const fileWithTag = { ...mockFabFile, tags: [{ name: 'datalake:lake-1' }] };
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(fileWithTag);
      mockAdapter.db.fabFiles.update.mockResolvedValue(fileWithTag);
      findByDatalakeTag.mockResolvedValue(mockLake);
      mockAdapter.origin = 'connector';

      await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'removed', origin: 'connector' }));
    });

    it('records nothing when the file is in no lake', async () => {
      const fileWithNoTags = { ...mockFabFile, tags: [] };
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(fileWithNoTags);
      mockAdapter.db.fabFiles.update.mockResolvedValue(fileWithNoTags);

      await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      expect(record).not.toHaveBeenCalled();
    });

    // A registry lake has no document, so findMemberLakesForFile (which resolves DB lakes for
    // chunk policy) cannot return one - but its open prefix arm is real membership, and this
    // delete costs the file that membership.
    it('records a removal from a static registry lake the DB lookup cannot resolve', async () => {
      const registryTag = `${DATA_LAKES[0].fileTagPrefix}handbook`;
      const fileWithTag = { ...mockFabFile, tags: [{ name: registryTag }] };
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(fileWithTag);
      mockAdapter.db.fabFiles.update.mockResolvedValue(fileWithTag);

      await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ dataLakeId: DATA_LAKES[0].id, fabFileId: mockFileId, action: 'removed' })
      );
    });

    it('records nothing on the unshared branch', async () => {
      const sharedFile = createMockSharedFile();
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(null);
      mockAdapter.db.fabFiles.findById.mockResolvedValue(sharedFile);

      const result = await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      expect(result.action).toBe('unshared');
      expect(record).not.toHaveBeenCalled();
    });

    it('records nothing on the not_found branch', async () => {
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(null);
      mockAdapter.db.fabFiles.findById.mockResolvedValue(null);

      const result = await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      expect(result.action).toBe('not_found');
      expect(record).not.toHaveBeenCalled();
    });

    it('does not fail the delete when the lake lookup throws', async () => {
      const fileWithTag = { ...mockFabFile, tags: [{ name: 'datalake:lake-1' }] };
      mockAdapter.db.fabFiles.findByIdAndUserId.mockResolvedValue(fileWithTag);
      mockAdapter.db.fabFiles.update.mockResolvedValue(fileWithTag);
      findByDatalakeTag.mockRejectedValue(new Error('lake lookup exploded'));

      const result = await deleteFabFile(mockUserId, { id: mockFileId }, mockAdapter);

      expect(result.action).toBe('deleted');
      expect(record).not.toHaveBeenCalled();
    });
  });
});
