import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const { findByIdMock, uploadMock, getSettingsValueMock } = vi.hoisted(() => ({
  findByIdMock: vi.fn(),
  uploadMock: vi.fn(),
  getSettingsValueMock: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ put: (h: unknown) => h }) }));
vi.mock('@bike4mind/database', () => ({ FabFile: { findById: findByIdMock }, adminSettingsRepository: {} }));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: vi.fn(async () => ({})),
  getSettingsValue: getSettingsValueMock,
}));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ upload: uploadMock }) }));

const handler = (await import('../upload')).default as (req: Request, res: Response) => Promise<unknown>;

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

const makeReq = (opts: { id?: string; userId?: string; body?: Buffer[] }) => {
  const chunks = opts.body ?? [Buffer.from('hello')];
  return {
    query: { id: opts.id ?? 'ff1' },
    user: { id: opts.userId ?? 'u1' },
    headers: { 'content-type': 'text/plain' },
    destroy: vi.fn(),
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  } as unknown as Request;
};

const PENDING_FILE = {
  id: 'ff1',
  userId: 'u1',
  status: 'pending',
  filePath: 'uploads/abc.txt',
  mimeType: 'text/plain',
};

describe('PUT /api/files/[id]/upload (self-host proxy)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.B4M_SELF_HOST = 'true';
    getSettingsValueMock.mockReturnValue(20); // 20 MB
    uploadMock.mockResolvedValue(undefined);
    findByIdMock.mockResolvedValue({ ...PENDING_FILE });
  });
  afterEach(() => {
    delete process.env.B4M_SELF_HOST;
  });

  it('returns 404 when not in self-host mode', async () => {
    process.env.B4M_SELF_HOST = 'false';
    const res = makeRes();
    await handler(makeReq({}), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(findByIdMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the file does not exist', async () => {
    findByIdMock.mockResolvedValue(null);
    const res = makeRes();
    await handler(makeReq({}), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the file belongs to another user', async () => {
    findByIdMock.mockResolvedValue({ ...PENDING_FILE, userId: 'someone-else' });
    const res = makeRes();
    await handler(makeReq({ userId: 'u1' }), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the file is not awaiting upload (already complete)', async () => {
    findByIdMock.mockResolvedValue({ ...PENDING_FILE, status: 'complete' });
    const res = makeRes();
    await handler(makeReq({}), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('returns 413 and aborts mid-stream when the body exceeds the size cap', async () => {
    getSettingsValueMock.mockReturnValue(0.00001); // ~10 bytes cap
    const req = makeReq({ body: [Buffer.alloc(50), Buffer.alloc(50)] });
    const res = makeRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(413);
    expect((req as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy).toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('writes the body to the file own storage key and returns 200 on success', async () => {
    const res = makeRes();
    await handler(makeReq({ body: [Buffer.from('hello '), Buffer.from('world')] }), res);

    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [body, key, options] = uploadMock.mock.calls[0];
    expect(Buffer.isBuffer(body)).toBe(true);
    expect((body as Buffer).toString()).toBe('hello world');
    expect(key).toBe('uploads/abc.txt');
    expect(options).toMatchObject({ ContentType: 'text/plain', ContentLength: 11 });
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
