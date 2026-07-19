import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const { findOneMock, saveMock, getSettingsValueMock, sendToQueueMock } = vi.hoisted(() => ({
  findOneMock: vi.fn(),
  saveMock: vi.fn(),
  getSettingsValueMock: vi.fn(),
  sendToQueueMock: vi.fn(),
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
vi.mock('sst', () => ({ Resource: { fabFileChunkQueue: { url: 'http://sqs/fabFileChunkQueue' } } }));

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
      chunkSize: '1000',
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
