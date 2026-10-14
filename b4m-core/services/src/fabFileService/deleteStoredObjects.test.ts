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
          sourceMetadata: { generatedCopyKey: 'a.png' },
        },
      ],
      storage,
      logger
    );

    expect(storage.files.delete).not.toHaveBeenCalled();
    expect(storage.generated.storage.delete).not.toHaveBeenCalled();
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
