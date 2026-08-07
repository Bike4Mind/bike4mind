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
      fabFileChunks: { deleteManyByFabFileId: Mock; bulkInsert: Mock; update: Mock };
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
        },
        users: { findById: vi.fn() },
      },
      storage: { getContentAsBuffer: vi.fn() },
      logger: { updateMetadata: vi.fn(), log: vi.fn() },
    };
  });

  it('deletes the OLD model index entries, not the new one being written', async () => {
    mockAdapter.searchIndex = { deleteByFabFileId: vi.fn().mockResolvedValue(undefined) };

    await chunkFabfile(
      mockUser,
      { fabFileId: 'file-1', embeddingModel: 'text-embedding-3-small' },
      mockAdapter as never
    );

    expect(mockAdapter.searchIndex.deleteByFabFileId).toHaveBeenCalledWith('file-1', 'text-embedding-ada-002');
  });

  it('skips the call when the file had no previous embeddingModel', async () => {
    mockAdapter.db.fabFiles.shareable.findAccessibleById.mockResolvedValue({
      ...mockFabFile,
      embeddingModel: undefined,
    });
    mockAdapter.searchIndex = { deleteByFabFileId: vi.fn() };

    await chunkFabfile(
      mockUser,
      { fabFileId: 'file-1', embeddingModel: 'text-embedding-3-small' },
      mockAdapter as never
    );

    expect(mockAdapter.searchIndex.deleteByFabFileId).not.toHaveBeenCalled();
  });

  it('is a no-op when searchIndex is not provided (non-self-host)', async () => {
    const result = await chunkFabfile(
      mockUser,
      { fabFileId: 'file-1', embeddingModel: 'text-embedding-3-small' },
      mockAdapter as never
    );
    expect(mockAdapter.db.fabFileChunks.bulkInsert).toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});
