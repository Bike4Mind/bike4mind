import { describe, expect, it, vi } from 'vitest';
import { deleteStoredObjects, deleteStoredObjectsAfterCommit } from './deleteStoredObjects';

const queued = vi.hoisted(() => ({ owned: true, work: new Map<string, () => Promise<unknown>>() }));
vi.mock('@bike4mind/db-core', () => ({
  runAfterCommit: (_session: unknown, key: string, work: () => Promise<unknown>) => {
    if (queued.owned) queued.work.set(key, work);
    return queued.owned;
  },
}));

const buckets = (sessionIdsShowingKey: string[] = []) => ({
  files: { delete: vi.fn().mockResolvedValue(undefined) },
  generated: {
    storage: { delete: vi.fn().mockResolvedValue(undefined) },
    quests: { findSessionIdsByMedia: vi.fn().mockResolvedValue(sessionIdsShowingKey) },
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

    expect(storage.generated.quests.findSessionIdsByMedia).toHaveBeenCalledWith('b.mp3');
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

describe('deleteStoredObjectsAfterCommit', () => {
  const session = {} as never;
  const file = { id: 'f1', filePath: 'uploads/a.pdf' };
  const log = { warn: vi.fn(), error: vi.fn() };

  it('queues the delete under an owned session and runs it only when the queue is drained', async () => {
    queued.owned = true;
    queued.work.clear();
    const storage = buckets();

    await deleteStoredObjectsAfterCommit([file], storage, { session, key: 'k', logger: log });
    expect(storage.files.delete).not.toHaveBeenCalled();

    await queued.work.get('k')!();
    expect(storage.files.delete).toHaveBeenCalledWith('uploads/a.pdf');
  });

  it('deletes inline when there is no session', async () => {
    const storage = buckets();

    await deleteStoredObjectsAfterCommit([file], storage, { key: 'k', logger: log });
    expect(storage.files.delete).toHaveBeenCalledWith('uploads/a.pdf');
  });

  it('deletes inline and warns when the session is not owned by withTransaction', async () => {
    queued.owned = false;
    const storage = buckets();

    await deleteStoredObjectsAfterCommit([file], storage, { session, key: 'k', logger: log });
    expect(storage.files.delete).toHaveBeenCalledWith('uploads/a.pdf');
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('not owned'), { key: 'k' });
  });

  it('logs a failed post-commit delete with the file id and key instead of throwing', async () => {
    queued.owned = true;
    queued.work.clear();
    const storage = buckets();
    storage.files.delete.mockRejectedValue(new Error('s3 down'));

    await deleteStoredObjectsAfterCommit([file], storage, { session, key: 'k', logger: log });
    await expect(queued.work.get('k')!()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('post-commit delete failed'),
      expect.objectContaining({ files: [{ fileId: 'f1', filePath: 'uploads/a.pdf' }], error: 's3 down' })
    );
  });

  describe('with a logger whose methods read `this`', () => {
    class ThisLogger {
      calls: string[] = [];
      warn(message: string) {
        this.calls.push(`warn:${message}`);
      }
      error(message: string) {
        this.calls.push(`error:${message}`);
      }
    }

    it('still attempts the file object and logs the orphan after a retained-version failure', async () => {
      queued.owned = true;
      queued.work.clear();
      const storage = buckets();
      storage.files.delete.mockImplementation(async (key: string) => {
        if (key === 'uploads/v1.pdf') throw new Error('s3 down');
      });
      const lg = new ThisLogger();
      const withVersion = { id: 'f1', filePath: 'uploads/a.pdf', versions: [version('uploads/v1.pdf')] };

      await deleteStoredObjectsAfterCommit([withVersion], storage, { session, key: 'k', logger: lg });
      await queued.work.get('k')!();

      expect(storage.files.delete).toHaveBeenCalledWith('uploads/a.pdf');
      expect(lg.calls.some(c => c.startsWith('warn:'))).toBe(true);
    });

    it('logs the orphan through the instance when the file object delete fails', async () => {
      queued.owned = true;
      queued.work.clear();
      const storage = buckets();
      storage.files.delete.mockRejectedValue(new Error('s3 down'));
      const lg = new ThisLogger();

      await deleteStoredObjectsAfterCommit([file], storage, { session, key: 'k', logger: lg });
      await expect(queued.work.get('k')!()).resolves.toBeUndefined();

      expect(lg.calls).toEqual([expect.stringContaining('error:[deleteStoredObjects] post-commit delete failed')]);
    });

    it('does not throw inline for a moderation-held file', async () => {
      const storage = buckets();
      const lg = new ThisLogger();
      const held = { id: 'f1', filePath: 'uploads/a.pdf', moderationStatus: 'blocked', blockReason: 'csam' } as never;

      await expect(deleteStoredObjectsAfterCommit([held], storage, { key: 'k', logger: lg })).resolves.toBeUndefined();
      expect(storage.files.delete).not.toHaveBeenCalled();
      expect(lg.calls[0]).toContain('legal hold');
    });
  });
});
