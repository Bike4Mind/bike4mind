import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const {
  findOneMock,
  updateOneMock,
  saveMock,
  getSettingsValueMock,
  sendToQueueMock,
  recomputeUploadedMock,
  historyDispatchMock,
  notebookDispatchMock,
  moderateFilesMock,
  moderationDeps,
  buildDepsMock,
  chargeMock,
  getMetadataMock,
  userFindByIdMock,
  userDoc,
  admitMock,
  recordLandedMock,
  recordRejectedBatchMock,
} = vi.hoisted(() => {
  const deps = { claim: vi.fn(), persist: vi.fn(), release: vi.fn() };
  return {
    admitMock: vi.fn(),
    recordRejectedBatchMock: vi.fn(),
    recordLandedMock: vi.fn(),
    chargeMock: vi.fn(),
    getMetadataMock: vi.fn(),
    userFindByIdMock: vi.fn(),
    userDoc: { save: vi.fn() },
    moderateFilesMock: vi.fn().mockResolvedValue({ scanned: 1 }),
    moderationDeps: deps,
    buildDepsMock: vi.fn(() => deps),
    findOneMock: vi.fn(),
    updateOneMock: vi.fn(),
    saveMock: vi.fn(),
    getSettingsValueMock: vi.fn(),
    sendToQueueMock: vi.fn(),
    recomputeUploadedMock: vi.fn(),
    historyDispatchMock: vi.fn().mockResolvedValue(undefined),
    notebookDispatchMock: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ post: (h: unknown) => h }) }));
vi.mock('@bike4mind/database', () => ({
  FabFile: { findOne: findOneMock, updateOne: updateOneMock },
  User: { findById: userFindByIdMock },
  adminSettingsRepository: { getSettingsValue: getSettingsValueMock },
  withTransaction: <T>(fn: (session: unknown) => Promise<T>) => fn({}),
}));
vi.mock('@bike4mind/server-utils/s3/storageCharge', () => ({ chargeUploadedObject: chargeMock }));
vi.mock('@bike4mind/server-utils/s3/uploadSizeGate', () => ({ admitLandedUpload: admitMock }));
vi.mock('@server/s3/recordRejectedUploadBatch', () => ({ recordRejectedUploadBatch: recordRejectedBatchMock }));
vi.mock('@server/s3/moderationScan', () => ({
  normalizeETag: (eTag?: string) => eTag?.replace(/^"|"$/g, '') || undefined,
  recordLandedObject: recordLandedMock,
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ getMetadata: getMetadataMock }),
}));
vi.mock('@server/s3/utils', () => ({
  decodeS3Key: (k: string) => decodeURIComponent(k.replace(/\+/g, ' ')),
  findWithRetry: <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ sendToQueue: sendToQueueMock }));
vi.mock('@server/dataLakes/recomputeStatsForUploadedFile', () => ({
  recomputeStatsForUploadedFile: recomputeUploadedMock,
}));
vi.mock('sst', () => ({
  Resource: {
    fabFileChunkQueue: { url: 'http://sqs/fabFileChunkQueue' },
    fabFileBucket: { name: 'b4m-fab-file' },
    historyImportBucket: { name: 'b4m-history-import' },
  },
}));
vi.mock('@server/s3/historyUploadComplete', () => ({ dispatch: historyDispatchMock }));
vi.mock('@server/s3/notebookImportComplete', () => ({ dispatch: notebookDispatchMock }));
vi.mock('@bike4mind/server-utils/s3/moderateImportedKnowledgeFiles', () => ({
  moderateImportedKnowledgeFiles: moderateFilesMock,
}));
vi.mock('@server/s3/knowledgeModerationDeps', () => ({ buildKnowledgeModerationDeps: buildDepsMock }));

const handler = (await import('../object-created')).default as (req: Request, res: Response) => Promise<unknown>;

const makeRes = () => {
  const res = {} as Response & { statusCode: number; body: unknown };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response['status'];
  res.json = vi.fn((payload: unknown) => {
    res.body = payload;
    return res;
  }) as unknown as Response['json'];
  return res;
};

const makeReq = (
  authorization: string | undefined,
  key: string,
  extra: { size?: number; eventTime?: string; eTag?: string } = {}
) =>
  ({
    headers: authorization === undefined ? {} : { authorization },
    body: {
      Records: [
        {
          ...(extra.eventTime ? { eventTime: extra.eventTime } : {}),
          s3: {
            object: {
              key,
              ...(extra.size !== undefined ? { size: extra.size } : {}),
              ...(extra.eTag ? { eTag: extra.eTag } : {}),
            },
          },
        },
      ],
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }) as unknown as Request;

describe('POST /api/internal/s3/object-created', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.B4M_SELF_HOST = 'true';
    process.env.INTERNAL_S3_WEBHOOK_SECRET = 'secret-token';
    getSettingsValueMock.mockResolvedValue(true);
    saveMock.mockResolvedValue(undefined);
    findOneMock.mockResolvedValue({ id: 'ff1', _id: 'ff1', userId: 'u1', status: 'pending', save: saveMock });
    userFindByIdMock.mockReturnValue({ session: () => Promise.resolve(userDoc) });
    chargeMock.mockResolvedValue(true);
    getMetadataMock.mockResolvedValue({ size: 42 });
    admitMock.mockResolvedValue(true);
  });
  afterEach(() => {
    delete process.env.B4M_SELF_HOST;
    delete process.env.INTERNAL_S3_WEBHOOK_SECRET;
  });

  it('recomputes the lakes the uploaded file joined, now that its bytes have landed (#1342)', async () => {
    // Self-host has no S3 events, so without this the hosted and self-host paths would disagree
    // about when a lake leaves 'draft'.
    findOneMock.mockResolvedValue({
      id: 'ff1',
      _id: 'ff1',
      userId: 'u1',
      status: 'pending',
      tags: [{ name: 'datalake:acme' }],
      save: saveMock,
    });
    const res = makeRes();

    await handler(makeReq('secret-token', 'uploads/a.pdf'), res);

    expect(recomputeUploadedMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'ff1' }), expect.anything());
  });

  it('returns 404 when not in self-host mode', async () => {
    process.env.B4M_SELF_HOST = 'false';
    const res = makeRes();
    await handler(makeReq('secret-token', 'uploads/a.pdf'), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(findOneMock).not.toHaveBeenCalled();
  });

  it('rejects a request with a missing or wrong secret', async () => {
    const res = makeRes();
    await handler(makeReq('wrong', 'uploads/a.pdf'), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(sendToQueueMock).not.toHaveBeenCalled();
  });

  it('accepts a Bearer-prefixed secret', async () => {
    const res = makeRes();
    await handler(makeReq('Bearer secret-token', 'uploads/a.pdf'), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('skips untracked keys (skip-list) without a lookup', async () => {
    const res = makeRes();
    await handler(makeReq('secret-token', 'temp/scratch.bin'), res);
    expect(findOneMock).not.toHaveBeenCalled();
    expect(sendToQueueMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('skips libreoncology/mock-oral/ objects without a lookup', async () => {
    const res = makeRes();
    const req = makeReq('secret-token', 'libreoncology/mock-oral/scene-1/audio.mp3');
    await handler(req, res);
    expect(findOneMock).not.toHaveBeenCalled();
    expect(sendToQueueMock).not.toHaveBeenCalled();
    expect(req.logger.info).toHaveBeenCalledWith(
      'Skipping S3 webhook for untracked file: libreoncology/mock-oral/scene-1/audio.mp3'
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it.each(['libreoncology/mock-oral-archive/x', 'uploads/libreoncology/mock-oral/x'])(
    'still looks up %s, which only contains the mock-oral prefix text',
    async key => {
      findOneMock.mockResolvedValue(null);
      const res = makeRes();
      await handler(makeReq('secret-token', key), res);
      expect(findOneMock).toHaveBeenCalledWith(expect.objectContaining({ filePath: key }), null, {
        includeDeleted: true,
      });
    }
  );

  it('marks the file complete and enqueues chunking on the happy path', async () => {
    const res = makeRes();
    await handler(makeReq('secret-token', 'uploads/report.pdf'), res);

    expect(findOneMock).toHaveBeenCalledWith(
      { filePath: 'uploads/report.pdf', $or: [{ deletedAt: null }, { uploadRejectedAt: { $ne: null } }] },
      null,
      { includeDeleted: true }
    );
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(sendToQueueMock).toHaveBeenCalledWith('http://sqs/fabFileChunkQueue', {
      fabFileId: 'ff1',
      userId: 'u1',
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('withdraws an upload the size gate rejects, without completing, charging or chunking it', async () => {
    admitMock.mockResolvedValue(false);
    const res = makeRes();
    await handler(makeReq('secret-token', 'uploads/report.pdf', { size: 999 }), res);

    expect(admitMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending' }),
      999,
      'uploads/report.pdf',
      expect.anything()
    );
    expect(saveMock).not.toHaveBeenCalled();
    expect(chargeMock).not.toHaveBeenCalled();
    expect(sendToQueueMock).not.toHaveBeenCalled();
    expect(recordRejectedBatchMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'ff1' }), expect.anything());
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('retries a rejected landing even when its already-deleted object has no HEAD metadata', async () => {
    findOneMock.mockResolvedValue({
      id: 'ff1',
      _id: 'ff1',
      userId: 'u1',
      status: 'pending',
      batchId: 'b1',
      uploadRejectedAt: new Date(),
      save: saveMock,
    });
    admitMock.mockResolvedValue(false);
    getMetadataMock.mockRejectedValue(new Error('NoSuchKey'));
    const res = makeRes();

    await handler(makeReq('secret-token', 'uploads/report.pdf'), res);

    expect(getMetadataMock).not.toHaveBeenCalled();
    expect(recordRejectedBatchMock).toHaveBeenCalledWith(expect.objectContaining({ batchId: 'b1' }), expect.anything());
    expect(saveMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('does not enqueue chunking when enableAutoChunk is off', async () => {
    getSettingsValueMock.mockResolvedValue(false);
    const res = makeRes();
    await handler(makeReq('secret-token', 'uploads/report.pdf'), res);

    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(sendToQueueMock).not.toHaveBeenCalled();
  });

  // Without this scan nothing moved a self-host file off 'pending' until the rescue sweep's
  // 30-minute floor, so every upload and generated video was unservable for half an hour.
  it('runs the upload-time moderation scan for the landed file, owned by its uploader', async () => {
    const req = makeReq('secret-token', 'uploads/clip.mp4');
    const res = makeRes();
    await handler(req, res);

    expect(moderateFilesMock).toHaveBeenCalledTimes(1);
    expect(moderateFilesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePaths: ['uploads/clip.mp4'],
        userId: 'u1',
        enabled: true,
        terminalOnMissingObject: false,
        claim: moderationDeps.claim,
      })
    );
    // The wiring must be the real thing, not a stray stub: the request logger carries the failure
    // context, and dropping `release` would strand a failed scan on 'scanning' instead of 'pending'.
    expect(buildDepsMock).toHaveBeenCalledWith(req.logger);
    expect(moderateFilesMock).toHaveBeenCalledWith(
      expect.objectContaining({ persist: moderationDeps.persist, release: moderationDeps.release })
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  // The scan is deliberately not awaited: holding MinIO's webhook on a full object download would
  // time it out and provoke a redelivery. A never-settling mock makes an `await` on that chain hang
  // this test, so it fails loudly instead of silently regressing to a blocking webhook.
  // A short per-test timeout so an `await` regression fails on the contract, not as a generic hang
  // against the 30s suite default.
  it('answers 200 before the upload-time scan settles', async () => {
    moderateFilesMock.mockImplementationOnce(() => new Promise(() => {}));
    const res = makeRes();

    await handler(makeReq('secret-token', 'uploads/clip.mp4'), res);

    expect(moderateFilesMock).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  }, 2000);

  it('passes the ImageModerationEnabled setting through to the scan', async () => {
    getSettingsValueMock.mockImplementation(async (name: string) => name !== 'ImageModerationEnabled');
    await handler(makeReq('secret-token', 'uploads/clip.mp4'), makeRes());

    expect(moderateFilesMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('defaults the scan to enabled when the setting has never been written', async () => {
    getSettingsValueMock.mockImplementation(async (name: string) =>
      name === 'ImageModerationEnabled' ? undefined : true
    );
    await handler(makeReq('secret-token', 'uploads/clip.mp4'), makeRes());

    expect(moderateFilesMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  // The file is already marked complete and chunking enqueued by now, so a 500 would make MinIO
  // redeliver and enqueue the chunk job twice. The file stays 'pending' for the sweep instead.
  it('still answers 200 and logs when building the scan wiring throws', async () => {
    buildDepsMock.mockImplementationOnce(() => {
      throw new Error('storage client misconfigured');
    });
    const req = makeReq('secret-token', 'uploads/photo.png');
    const res = makeRes();
    await handler(req, res);
    await new Promise(resolve => setImmediate(resolve));

    expect(res.status).toHaveBeenCalledWith(200);
    expect(moderateFilesMock).not.toHaveBeenCalled();
    expect(req.logger.error).toHaveBeenCalledWith(expect.stringContaining('storage client misconfigured'));
  });

  it('records the landed ETag before the scan, so an overwrite of a judged file is rescanned', async () => {
    await handler(makeReq('secret-token', 'uploads/a.pdf', { size: 5, eTag: 'etag-b' }), makeRes());
    await vi.waitFor(() => expect(moderateFilesMock).toHaveBeenCalled());

    expect(recordLandedMock).toHaveBeenCalledWith('ff1', 'uploads/a.pdf', expect.anything());
    expect(recordLandedMock.mock.invocationCallOrder[0]).toBeLessThan(moderateFilesMock.mock.invocationCallOrder[0]);
  });

  it('reconciles the current storage version when the notification omits its ETag', async () => {
    getMetadataMock.mockResolvedValue({ size: 5, etag: '"etag-c"' });
    await handler(makeReq('secret-token', 'uploads/a.pdf', { size: 5 }), makeRes());

    expect(recordLandedMock).toHaveBeenCalledWith('ff1', 'uploads/a.pdf', expect.anything());
  });

  it('retries before scanning or charging when current-version reconciliation fails', async () => {
    recordLandedMock.mockRejectedValueOnce(new Error('head unavailable'));
    await expect(handler(makeReq('secret-token', 'uploads/a.pdf', { size: 5 }), makeRes())).rejects.toThrow(
      'head unavailable'
    );
    expect(chargeMock).not.toHaveBeenCalled();
    expect(moderateFilesMock).not.toHaveBeenCalled();
    expect(sendToQueueMock).not.toHaveBeenCalled();
  });

  it('does not scan or charge when the file has no metadata row', async () => {
    findOneMock.mockResolvedValue(null);
    await handler(makeReq('secret-token', 'uploads/orphan.mp4'), makeRes());

    expect(moderateFilesMock).not.toHaveBeenCalled();
    expect(chargeMock).not.toHaveBeenCalled();
  });

  describe('storage charge', () => {
    const EVENT_TIME = '2026-10-13T12:00:00.000Z';

    it("charges the owner the payload's object size, stamped with the event time", async () => {
      await handler(
        makeReq('secret-token', 'uploads/a.pdf', { size: 1234, eventTime: EVENT_TIME, eTag: 'etag-a' }),
        makeRes()
      );

      expect(userFindByIdMock).toHaveBeenCalledWith('u1');
      expect(chargeMock).toHaveBeenCalledWith('ff1', userDoc, 1234, new Date(EVENT_TIME), 'pending', {});
      expect(getMetadataMock).not.toHaveBeenCalled();
      expect(userDoc.save).toHaveBeenCalledWith({ session: {} });
    });

    it('judges the charge by the status the row had before this webhook marked it complete', async () => {
      findOneMock.mockResolvedValue({ id: 'ff1', _id: 'ff1', userId: 'u1', save: saveMock });
      await handler(makeReq('secret-token', 'uploads/a.pdf', { size: 1234, eventTime: EVENT_TIME }), makeRes());

      expect(chargeMock).toHaveBeenCalledWith('ff1', userDoc, 1234, new Date(EVENT_TIME), undefined, {});
    });

    it('falls back to the stored object size when the payload has none', async () => {
      await handler(makeReq('secret-token', 'uploads/a.pdf'), makeRes());

      expect(getMetadataMock).toHaveBeenCalledWith('uploads/a.pdf');
      expect(chargeMock).toHaveBeenCalledWith('ff1', userDoc, 42, expect.any(Date), 'pending', {});
    });

    it('falls back to the stored object size when the payload size is invalid', async () => {
      await handler(makeReq('secret-token', 'uploads/a.pdf', { size: -1 }), makeRes());

      expect(getMetadataMock).toHaveBeenCalledWith('uploads/a.pdf');
      expect(chargeMock).toHaveBeenCalledWith('ff1', userDoc, 42, expect.any(Date), 'pending', {});
    });

    it('stamps the current time when the event time does not parse', async () => {
      await handler(makeReq('secret-token', 'uploads/a.pdf', { size: 10, eventTime: 'not-a-date' }), makeRes());

      const uploadedAt = chargeMock.mock.calls[0][3] as Date;
      expect(Number.isNaN(uploadedAt.getTime())).toBe(false);
    });

    // An unmeasured landing cannot be judged by the size gate, so it fails for MinIO to redeliver.
    it('fails without completing, charging or chunking when neither source has a size', async () => {
      getMetadataMock.mockResolvedValue({});
      await expect(handler(makeReq('secret-token', 'uploads/a.pdf'), makeRes())).rejects.toThrow(
        'No object size for uploads/a.pdf'
      );

      expect(admitMock).not.toHaveBeenCalled();
      expect(saveMock).not.toHaveBeenCalled();
      expect(chargeMock).not.toHaveBeenCalled();
      expect(sendToQueueMock).not.toHaveBeenCalled();
    });

    it('charges nothing when the owner no longer exists', async () => {
      userFindByIdMock.mockReturnValue({ session: () => Promise.resolve(null) });
      await handler(makeReq('secret-token', 'uploads/a.pdf', { size: 10 }), makeRes());

      expect(chargeMock).not.toHaveBeenCalled();
    });

    it('does not save the owner when a redelivery loses the claim', async () => {
      chargeMock.mockResolvedValue(false);
      await handler(makeReq('secret-token', 'uploads/a.pdf', { size: 10, eventTime: EVENT_TIME }), makeRes());

      expect(chargeMock).toHaveBeenCalledTimes(1);
      expect(userDoc.save).not.toHaveBeenCalled();
    });

    it('still answers 200 and enqueues chunking when the charge throws', async () => {
      chargeMock.mockRejectedValue(new Error('write conflict'));
      const req = makeReq('secret-token', 'uploads/a.pdf', { size: 10 });
      const res = makeRes();
      await handler(req, res);

      expect(req.logger.error).toHaveBeenCalledWith(expect.stringContaining('write conflict'));
      expect(sendToQueueMock).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });
});

/**
 * One MinIO webhook feeds every bucket, but the body above only ever did fab-file work. Hosted
 * wires THREE ObjectCreated notifications (app-files, history-import, and history-import again
 * under the notebooks/ prefix); self-host wired one, so LLM history import and notebook import
 * both uploaded successfully and were then never processed.
 */
describe('POST /api/internal/s3/object-created - bucket dispatch', () => {
  const makeBucketReq = (bucket: string | undefined, key: string) =>
    ({
      headers: { authorization: 'secret-token' },
      body: { Records: [{ s3: { ...(bucket ? { bucket: { name: bucket } } : {}), object: { key } } }] },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }) as unknown as Request;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.B4M_SELF_HOST = 'true';
    process.env.INTERNAL_S3_WEBHOOK_SECRET = 'secret-token';
    getSettingsValueMock.mockResolvedValue(true);
    saveMock.mockResolvedValue(undefined);
    findOneMock.mockResolvedValue({ id: 'ff1', _id: 'ff1', userId: 'u1', status: 'pending', save: saveMock });
    userFindByIdMock.mockReturnValue({ session: () => Promise.resolve(userDoc) });
    getMetadataMock.mockResolvedValue({ size: 42 });
  });
  afterEach(() => {
    delete process.env.B4M_SELF_HOST;
    delete process.env.INTERNAL_S3_WEBHOOK_SECRET;
  });

  it('sends a history-import object to the history handler, not the fab-file path', async () => {
    await handler(makeBucketReq('b4m-history-import', 'user1/OpenAI/1234.zip'), makeRes());
    expect(historyDispatchMock).toHaveBeenCalledTimes(1);
    expect(findOneMock).not.toHaveBeenCalled();
  });

  it('sends a notebooks/ object to the notebook handler (same bucket, different prefix)', async () => {
    await handler(makeBucketReq('b4m-history-import', 'notebooks/user1/1234.json'), makeRes());
    expect(notebookDispatchMock).toHaveBeenCalledTimes(1);
    expect(historyDispatchMock).not.toHaveBeenCalled();
  });

  it('passes the record through as an S3-shaped event the hosted handler already understands', async () => {
    await handler(makeBucketReq('b4m-history-import', 'user1/OpenAI/1234.zip'), makeRes());
    const [event] = historyDispatchMock.mock.calls[0];
    expect(event.Records[0].s3.bucket.name).toBe('b4m-history-import');
    expect(event.Records[0].s3.object.key).toBe('user1/OpenAI/1234.zip');
  });

  it('still runs the fab-file path for a fab-file object', async () => {
    await handler(makeBucketReq('b4m-fab-file', 'u1/doc.md'), makeRes());
    expect(findOneMock).toHaveBeenCalled();
    expect(historyDispatchMock).not.toHaveBeenCalled();
  });

  it('treats a record with no bucket name as fab-file, preserving existing behaviour', async () => {
    await handler(makeBucketReq(undefined, 'u1/doc.md'), makeRes());
    expect(findOneMock).toHaveBeenCalled();
  });

  it('ignores a bucket it has no handler for rather than guessing', async () => {
    await handler(makeBucketReq('b4m-slack-export', 'exports-x/dump.json'), makeRes());
    expect(findOneMock).not.toHaveBeenCalled();
    expect(historyDispatchMock).not.toHaveBeenCalled();
    expect(notebookDispatchMock).not.toHaveBeenCalled();
  });
});
