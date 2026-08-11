import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import { chunkFabfile } from './chunk';
import type { IUserDocument } from '@bike4mind/common';

vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return { ...actual, SmartChunker: vi.fn() };
});

import { SmartChunker } from '@bike4mind/utils';

describe('chunkFabfile', () => {
  const mockUser = { id: 'user-1' } as IUserDocument;
  const mockFabFile = {
    id: 'file-1',
    embeddingModel: 'text-embedding-ada-002',
    mimeType: 'text/plain',
  };

  let mockAdapter: {
    db: {
      fabFiles: { shareable: { findAccessibleById: Mock }; update: Mock };
      fabFileChunks: {
        deleteManyByFabFileId: Mock;
        bulkInsert: Mock;
        update: Mock;
        distinctEmbeddingModelsByFabFileIds: Mock;
      };
      users: { findById: Mock };
    };
    storage: { getContentAsBuffer: Mock };
    logger: { updateMetadata: Mock; log: Mock };
    searchIndex?: { deleteByFabFileId: Mock };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (SmartChunker as unknown as Mock).mockImplementation(function MockSmartChunker(this: unknown) {
      return {
        chunkFile: vi.fn().mockResolvedValue([{ text: 'chunk one', tokenCount: 2 }]),
        freeEncoder: vi.fn(),
      };
    });

    mockAdapter = {
      db: {
        fabFiles: {
          shareable: { findAccessibleById: vi.fn().mockResolvedValue({ ...mockFabFile }) },
          update: vi.fn(),
        },
        fabFileChunks: {
          deleteManyByFabFileId: vi.fn(),
          bulkInsert: vi.fn().mockResolvedValue([]),
          update: vi.fn(),
          distinctEmbeddingModelsByFabFileIds: vi.fn().mockResolvedValue([]),
        },
        users: { findById: vi.fn() },
      },
      storage: { getContentAsBuffer: vi.fn() },
      logger: { updateMetadata: vi.fn(), log: vi.fn() },
    };
  });

  it('deletes every OLD model the chunk store actually used, not just FabFile.embeddingModel, and not the new one being written', async () => {
    // A file re-embedded more than once can have chunks under more than one prior model (see
    // IFabFileChunk.embeddingModel) - fabFile.embeddingModel alone is only the CURRENT one.
    mockAdapter.db.fabFileChunks.distinctEmbeddingModelsByFabFileIds.mockResolvedValue([
      'text-embedding-ada-002',
      'text-embedding-3-small-old',
    ]);
    mockAdapter.searchIndex = { deleteByFabFileId: vi.fn().mockResolvedValue(undefined) };

    await chunkFabfile(
      mockUser,
      { fabFileId: 'file-1', embeddingModel: 'text-embedding-3-small' },
      mockAdapter as never
    );

    expect(mockAdapter.db.fabFileChunks.distinctEmbeddingModelsByFabFileIds).toHaveBeenCalledWith(['file-1']);
    expect(mockAdapter.searchIndex.deleteByFabFileId).toHaveBeenCalledTimes(2);
    expect(mockAdapter.searchIndex.deleteByFabFileId).toHaveBeenCalledWith('file-1', 'text-embedding-ada-002');
    expect(mockAdapter.searchIndex.deleteByFabFileId).toHaveBeenCalledWith('file-1', 'text-embedding-3-small-old');
  });

  it('skips the delete calls when the chunk store has no prior models for this file', async () => {
    mockAdapter.db.fabFileChunks.distinctEmbeddingModelsByFabFileIds.mockResolvedValue([]);
    mockAdapter.searchIndex = { deleteByFabFileId: vi.fn() };

    await chunkFabfile(
      mockUser,
      { fabFileId: 'file-1', embeddingModel: 'text-embedding-3-small' },
      mockAdapter as never
    );

    expect(mockAdapter.searchIndex.deleteByFabFileId).not.toHaveBeenCalled();
  });

  it('is a no-op when searchIndex is not provided (non-self-host) - never even queries the chunk store', async () => {
    const result = await chunkFabfile(
      mockUser,
      { fabFileId: 'file-1', embeddingModel: 'text-embedding-3-small' },
      mockAdapter as never
    );
    expect(mockAdapter.db.fabFileChunks.bulkInsert).toHaveBeenCalled();
    expect(mockAdapter.db.fabFileChunks.distinctEmbeddingModelsByFabFileIds).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});
