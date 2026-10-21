import { describe, expect, it, vi } from 'vitest';
import { deleteStoredObjects } from './deleteStoredObjects';

const buckets = (sessionIdsShowingKey: string[] = []) => ({
  files: { delete: vi.fn().mockResolvedValue(undefined) },
  generated: {
    storage: { delete: vi.fn().mockResolvedValue(undefined) },
    quests: { findSessionIdsByImage: vi.fn().mockResolvedValue(sessionIdsShowingKey) },
  },
});
const logger = { warn: vi.fn() };
const version = (filePath: string) => ({ version: 1, filePath, fileSize: 1, mimeType: 'x', createdAt: new Date(0) });

describe('deleteStoredObjects', () => {
  it("deletes each file's object and any generated-bucket copy", async () => {
    const storage = buckets(['s1']);

    await deleteStoredObjects(
      [
        { id: 'f1', filePath: 'uploads/a.pdf' },
        { id: 'f2', filePath: 'generated-audio/b.mp3', sourceMetadata: { sessionId: 's1', generatedCopyKey: 'b.mp3' } },
        { id: 'f3', filePath: 'generated-video/c.mp4', sourceMetadata: { sessionId: 's1' } },
      ],
      storage,
      logger
    );

    expect(storage.files.delete.mock.calls.map(([key]) => key)).toEqual([
      'uploads/a.pdf',
      'generated-audio/b.mp3',
      'generated-video/c.mp4',
    ]);
    expect(storage.generated.storage.delete.mock.calls).toEqual([['b.mp3']]);
  });

  it("deletes each of an AI-edited file's retained version keys once", async () => {
    const storage = buckets();

    await deleteStoredObjects(
      [{ id: 'f1', filePath: 'v3.docx', versions: [version('v1.docx'), version('v2.docx'), version('v3.docx')] }],
      storage,
      logger
    );

    expect(storage.files.delete.mock.calls.map(([key]) => key)).toEqual(['v1.docx', 'v2.docx', 'v3.docx']);
  });

  it('logs and carries on when a retained version fails, and still removes filePath', async () => {
    const storage = buckets();
    storage.files.delete.mockImplementation(async (key: string) => {
      if (key === 'v1.docx') throw new Error('S3 unavailable');
    });
    logger.warn.mockClear();

    await expect(
      deleteStoredObjects(
        [{ id: 'f1', filePath: 'v3.docx', versions: [version('v1.docx'), version('v3.docx')] }],
        storage,
        logger
      )
    ).resolves.toBeUndefined();

    expect(storage.files.delete.mock.calls.map(([key]) => key)).toEqual(['v1.docx', 'v3.docx']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('retained version'),
      expect.objectContaining({ fileId: 'f1', key: 'v1.docx' })
    );
  });

  it('rejects when the current filePath fails to delete', async () => {
    const storage = buckets();
    storage.files.delete.mockImplementation(async (key: string) => {
      if (key === 'v3.docx') throw new Error('S3 unavailable');
    });

    await expect(
      deleteStoredObjects(
        [{ id: 'f1', filePath: 'v3.docx', versions: [version('v1.docx'), version('v3.docx')] }],
        storage,
        logger
      )
    ).rejects.toThrow('S3 unavailable');
  });

  it('keeps a generated copy that a forked or cloned notebook still shows', async () => {
    const storage = buckets(['s1', 's-fork']);

    await deleteStoredObjects(
      [{ id: 'f1', filePath: 'generated-audio/b.mp3', sourceMetadata: { sessionId: 's1', generatedCopyKey: 'b.mp3' } }],
      storage,
      logger
    );

    expect(storage.generated.quests.findSessionIdsByImage).toHaveBeenCalledWith('b.mp3');
    expect(storage.files.delete).toHaveBeenCalledWith('generated-audio/b.mp3');
    expect(storage.generated.storage.delete).not.toHaveBeenCalled();
  });

  it('keeps a copy it cannot place in a notebook of its own once any reply shows it', async () => {
    const storage = buckets(['s1']);

    await deleteStoredObjects([{ id: 'f1', sourceMetadata: { generatedCopyKey: 'b.mp3' } }], storage, logger);

    expect(storage.generated.storage.delete).not.toHaveBeenCalled();
  });

  it('keeps every object of a moderation-blocked file (legal hold)', async () => {
    const storage = buckets();

    await deleteStoredObjects(
      [
        {
          id: 'f1',
          filePath: 'uploads/a.png',
          moderationStatus: 'blocked',
          versions: [version('uploads/a-v1.png')],
          sourceMetadata: { generatedCopyKey: 'a.png' },
        },
      ],
      storage,
      logger
    );

    expect(storage.files.delete).not.toHaveBeenCalled();
    expect(storage.generated.storage.delete).not.toHaveBeenCalled();
  });

  it('still deletes a file blocked only for an unscannable format (never an incident)', async () => {
    const storage = buckets();
    logger.warn.mockClear();

    await deleteStoredObjects(
      [
        {
          id: 'f1',
          filePath: 'uploads/a.heic',
          moderationStatus: 'blocked',
          blockReason: 'unsupported_format',
          versions: [version('uploads/a-v1.heic')],
          sourceMetadata: { generatedCopyKey: 'a.heic' },
        },
      ],
      storage,
      logger
    );

    expect(storage.files.delete).toHaveBeenCalledWith('uploads/a.heic');
    expect(storage.files.delete).toHaveBeenCalledWith('uploads/a-v1.heic');
    expect(storage.generated.storage.delete).toHaveBeenCalledWith('a.heic');
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('legal hold'), expect.anything());
  });

  it('skips a file with no stored object', async () => {
    const storage = buckets();

    await deleteStoredObjects([{ id: 'f1' }], storage, logger);

    expect(storage.files.delete).not.toHaveBeenCalled();
    expect(storage.generated.storage.delete).not.toHaveBeenCalled();
  });

  it('logs a copy it cannot reach when no generated bucket is wired', async () => {
    const { files } = buckets();

    await deleteStoredObjects([{ id: 'f1', sourceMetadata: { generatedCopyKey: 'b.mp3' } }], { files }, logger);

    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { fileId: 'f1', copyKey: 'b.mp3' });
  });

  it('rejects when a storage delete fails, so the caller does not report a clean delete', async () => {
    const storage = buckets();
    storage.files.delete.mockRejectedValue(new Error('denied'));

    await expect(deleteStoredObjects([{ id: 'f1', filePath: 'a' }], storage, logger)).rejects.toThrow('denied');
  });
});
