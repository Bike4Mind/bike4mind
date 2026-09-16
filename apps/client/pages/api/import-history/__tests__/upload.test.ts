import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadTooLargeError } from '@server/utils/spoolRequestToFile';
import type { Request, Response } from 'express';

type RouteHandler = (req: Request, res: Response) => Promise<unknown>;

const { uploadMock, getSignedUrlMock, spoolMock, captured } = vi.hoisted(() => ({
  uploadMock: vi.fn(),
  getSignedUrlMock: vi.fn(),
  spoolMock: vi.fn(),
  captured: {} as {
    get?: (req: unknown, res: unknown) => Promise<unknown>;
    put?: (req: unknown, res: unknown) => Promise<unknown>;
  },
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const router = {
      get(h: RouteHandler) {
        captured.get = h as (req: unknown, res: unknown) => Promise<unknown>;
        return router;
      },
      put(h: RouteHandler) {
        captured.put = h as (req: unknown, res: unknown) => Promise<unknown>;
        return router;
      },
    };
    return router;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (h: RouteHandler) => h }));
vi.mock('@bike4mind/common', () => ({ Permission: { create: 'create' } }));
vi.mock('@bike4mind/database/auth', () => ({ Session: class Session {} }));
vi.mock('@bike4mind/services', () => ({
  importHistoryService: { ImportSource: { OPENAI: 'OpenAI', CLAUDE: 'Claude' } },
}));
vi.mock('@bike4mind/fab-pipeline', () => ({
  S3Storage: class {
    upload = uploadMock;
    getSignedUrl = getSignedUrlMock;
  },
}));
vi.mock('sst', () => ({ Resource: { historyImportBucket: { name: 'history-bucket' } } }));
// Real spooler by default, so the cases below still exercise the disk path. Only the 413 case
// swaps in a rejection: crossing the 1 GB cap for real would write a gibibyte to the runner's
// temp disk on every shard, and spoolRequestToFile.test.ts already proves the cap with 6 bytes.
vi.mock('@server/utils/spoolRequestToFile', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/utils/spoolRequestToFile')>();
  spoolMock.mockImplementation(actual.spoolRequestToFile);
  return { ...actual, spoolRequestToFile: spoolMock };
});

const { MAX_HISTORY_UPLOAD_BYTES } = await import('../upload');

const makeRes = () => {
  const res = {} as Response & { statusCode: number; body: unknown };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response['status'];
  res.json = vi.fn((payload: unknown) => {
    res.body = payload;
    res.listeners.finish?.forEach(fn => fn());
    return res;
  }) as unknown as Response['json'];
  res.listeners = {} as Record<string, Array<() => void>>;
  res.on = vi.fn((event: string, fn: () => void) => {
    (res.listeners[event] ??= []).push(fn);
    return res;
  }) as unknown as Response['on'];
  return res;
};

const makeReq = (opts: { query?: Record<string, unknown>; userId?: string; chunks?: string[] } = {}) => {
  const chunks = opts.chunks ?? ['history-zip-bytes'];
  return {
    query: opts.query ?? { source: 'OpenAI' },
    user: { id: opts.userId ?? 'user-1' },
    ability: { can: () => true },
    destroy: vi.fn(),
    socket: { end: vi.fn() },
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield Buffer.from(c);
    },
  } as unknown as Request;
};

describe('PUT /api/import-history/upload (self-host proxy)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.B4M_SELF_HOST = 'true';
    uploadMock.mockResolvedValue(undefined);
  });
  afterEach(() => {
    delete process.env.B4M_SELF_HOST;
  });

  it('404s when not in self-host mode, so hosted keeps its direct-to-S3 upload', async () => {
    process.env.B4M_SELF_HOST = 'false';
    const res = makeRes();
    await captured.put!(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('rejects a source outside the known import sources', async () => {
    const res = makeRes();
    await captured.put!(makeReq({ query: { source: 'Bogus' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('writes under a key derived from the authenticated user, not from the client', async () => {
    // historyUploadComplete parses userId and source back out of this key to decide whose
    // import it is, so a client-controlled key would let a caller attribute an import to
    // someone else. Everything the client sends about the destination is ignored.
    const res = makeRes();
    await captured.put!(
      makeReq({
        userId: 'user-1',
        query: { source: 'OpenAI', key: 'victim/OpenAI/evil.zip', path: '../../etc/passwd' },
      }),
      res
    );

    expect(uploadMock).toHaveBeenCalledTimes(1);
    const key = uploadMock.mock.calls[0][1] as string;
    expect(key).toMatch(/^user-1\/OpenAI\/\d+\.zip$/);
    expect(key).not.toContain('victim');
    expect(key).not.toContain('..');
  });

  it('413s a body over the cap without uploading anything', async () => {
    spoolMock.mockRejectedValueOnce(new UploadTooLargeError(MAX_HISTORY_UPLOAD_BYTES));
    const res = makeRes();
    const req = makeReq();
    await captured.put!(req, res);
    // The cap the route hands the spooler is part of what breaks if this constant drifts.
    expect(spoolMock).toHaveBeenCalledWith(req, MAX_HISTORY_UPLOAD_BYTES, { filename: 'history.zip' });
    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.body).toEqual(expect.objectContaining({ maxBytes: MAX_HISTORY_UPLOAD_BYTES }));
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('tears the socket down with a FIN after the 413 flushes, never an RST', async () => {
    // Measured against real sockets: destroying the request discards the queued response, so the
    // client gets ECONNRESET instead of the size message. Ending after 'finish' delivers it.
    spoolMock.mockRejectedValueOnce(new UploadTooLargeError(MAX_HISTORY_UPLOAD_BYTES));
    const res = makeRes();
    const req = makeReq();
    await captured.put!(req, res);
    expect(req.destroy).not.toHaveBeenCalled();
    expect(req.socket.end).toHaveBeenCalledTimes(1);
  });

  it('uploads the spooled file by path so the bytes never sit in memory', async () => {
    const res = makeRes();
    await captured.put!(makeReq(), res);
    const [input] = uploadMock.mock.calls[0];
    expect(typeof input).toBe('string');
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('GET /api/import-history/upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSignedUrlMock.mockResolvedValue('http://minio:9000/history-bucket/user-1/OpenAI/1.zip?sig=x');
  });
  afterEach(() => {
    delete process.env.B4M_SELF_HOST;
  });

  it('hands back the same-origin proxy route on self-host, never the MinIO presign', async () => {
    process.env.B4M_SELF_HOST = 'true';
    const res = makeRes();
    await captured.get!(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ url: '/api/import-history/upload?source=OpenAI' }));
    // The presign would only be discarded, so it is never minted - no MinIO round trip per import.
    expect(getSignedUrlMock).not.toHaveBeenCalled();
  });

  it('hands back the presigned URL when hosted', async () => {
    process.env.B4M_SELF_HOST = 'false';
    const res = makeRes();
    await captured.get!(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://minio:9000/history-bucket/user-1/OpenAI/1.zip?sig=x' })
    );
  });
});
