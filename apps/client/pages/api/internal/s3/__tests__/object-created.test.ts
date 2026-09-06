import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const {
  findOneMock,
  saveMock,
  getSettingsValueMock,
  sendToQueueMock,
  recomputeUploadedMock,
  historyDispatchMock,
  notebookDispatchMock,
} = vi.hoisted(() => ({
  findOneMock: vi.fn(),
  saveMock: vi.fn(),
  getSettingsValueMock: vi.fn(),
  sendToQueueMock: vi.fn(),
  recomputeUploadedMock: vi.fn(),
  historyDispatchMock: vi.fn().mockResolvedValue(undefined),
  notebookDispatchMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ post: (h: unknown) => h }) }));
vi.mock('@bike4mind/database', () => ({
  FabFile: { findOne: findOneMock },
  adminSettingsRepository: { getSettingsValue: getSettingsValueMock },
}));
vi.mock('@server/s3/utils', () => ({
  decodeS3Key: (k: string) => decodeURIComponent(k.replace(/\+/g, ' ')),
  findWithRetry: <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: sendToQueueMock }));
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

const makeReq = (authorization: string | undefined, key: string) =>
  ({
    headers: authorization === undefined ? {} : { authorization },
    body: { Records: [{ s3: { object: { key } } }] },
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

  it('marks the file complete and enqueues chunking on the happy path', async () => {
    const res = makeRes();
    await handler(makeReq('secret-token', 'uploads/report.pdf'), res);

    expect(findOneMock).toHaveBeenCalledWith({ filePath: 'uploads/report.pdf' });
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(sendToQueueMock).toHaveBeenCalledWith('http://sqs/fabFileChunkQueue', {
      fabFileId: 'ff1',
      userId: 'u1',
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('does not enqueue chunking when enableAutoChunk is off', async () => {
    getSettingsValueMock.mockResolvedValue(false);
    const res = makeRes();
    await handler(makeReq('secret-token', 'uploads/report.pdf'), res);

    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(sendToQueueMock).not.toHaveBeenCalled();
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
