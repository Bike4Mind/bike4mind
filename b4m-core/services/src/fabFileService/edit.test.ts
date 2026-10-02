import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { FAB_FILE_CONTENT_REWRITE_PATCH, IUserDocument } from '@bike4mind/common';
import { editFabFile } from './edit';

describe('editFabFile (narrowed write on apply)', () => {
  const NOW = new Date('2026-01-01T00:00:00Z');
  const user = { id: 'user-1' } as IUserDocument;

  let db: { fabFiles: { shareable: { findAccessibleById: Mock }; update: Mock } };
  let llm: { complete: Mock };
  let storage: { upload: Mock; generateSignedUrl: Mock };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    db = {
      fabFiles: {
        shareable: {
          findAccessibleById: vi.fn().mockResolvedValue({
            id: 'file-1',
            fileName: 'notes.txt',
            mimeType: 'text/plain',
            filePath: 'uploads/notes.txt',
            moderationStatus: 'clean',
          }),
        },
        update: vi.fn().mockResolvedValue(undefined),
      },
    };
    llm = { complete: vi.fn().mockResolvedValue('edited text') };
    storage = {
      upload: vi.fn().mockResolvedValue(undefined),
      generateSignedUrl: vi.fn().mockResolvedValue('https://s3.example.com/signed'),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes only the content-rewrite fields when applyImmediately is true', async () => {
    const result = await editFabFile(
      user,
      { id: 'file-1', instruction: 'x', preserveFormatting: true, applyImmediately: true },
      {
        db,
        llm,
        storage,
      } as unknown as Parameters<typeof editFabFile>[2]
    );

    expect(result.applied).toBe(true);
    expect(db.fabFiles.update).toHaveBeenCalledTimes(1);
    expect(db.fabFiles.update.mock.calls[0]).toStrictEqual([
      {
        id: 'file-1',
        fileUrl: 'https://s3.example.com/signed',
        fileUrlExpireAt: new Date('2026-01-01T01:00:00Z'),
        filePath: 'uploads/notes.txt',
        updatedAt: NOW,
        ...FAB_FILE_CONTENT_REWRITE_PATCH,
      },
    ]);
  });

  it('does not write when applyImmediately is false', async () => {
    const result = await editFabFile(
      user,
      { id: 'file-1', instruction: 'x', preserveFormatting: true, applyImmediately: false },
      {
        db,
        llm,
        storage,
      } as unknown as Parameters<typeof editFabFile>[2]
    );

    expect(result.applied).toBe(false);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(db.fabFiles.update).not.toHaveBeenCalled();
  });
});
