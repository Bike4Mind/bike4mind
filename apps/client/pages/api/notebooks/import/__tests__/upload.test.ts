import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { UploadTooLargeError } from '@server/utils/spoolRequestToFile';
import { MAX_NOTEBOOK_IMPORT_UPLOAD_BYTES } from '../upload';

type RouteHandler = (req: Request, res: Response) => Promise<unknown>;

const { uploadMock, spoolMock, captured } = vi.hoisted(() => ({
  uploadMock: vi.fn(),
  spoolMock: vi.fn(),
  captured: {} as {
    put?: (req: unknown, res: unknown) => Promise<unknown>;
  },
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const router = {
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
vi.mock('@bike4mind/fab-pipeline', () => ({
  S3Storage: class {
    upload = uploadMock;
  },
}));
vi.mock('sst', () => ({ Resource: { historyImportBucket: { name: 'history-bucket' } } }));
// Wraps the real spool by default so every other case still exercises real streaming on a few
// bytes; only the cap case is stubbed, so the 413 assertion costs no disk.
vi.mock('@server/utils/spoolRequestToFile', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/utils/spoolRequestToFile')>();
  spoolMock.mockImplementation(actual.spoolRequestToFile);
  return { ...actual, spoolRequestToFile: spoolMock };
});

await import('../upload');

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

const makeReq = (
  opts: { query?: Record<string, unknown>; userId?: string; chunks?: string[]; canCreate?: boolean } = {}
) => {
  const chunks = opts.chunks ?? ['notebook-json-bytes'];
  return {
    query: opts.query ?? { importId: '1700000000000' },
    user: { id: opts.userId ?? 'user-1' },
    ability: { can: () => opts.canCreate ?? true },
    destroy: vi.fn(),
    socket: { end: vi.fn() },
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield Buffer.from(c);
    },
  } as unknown as Request;
};

describe('PUT /api/notebooks/import/upload (self-host proxy)', () => {
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

  it('rejects an importId that is not digits-only', async () => {
    const res = makeRes();
    await captured.put!(makeReq({ query: { importId: 'abc' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('rejects a traversal-shaped importId', async () => {
    const res = makeRes();
    await captured.put!(makeReq({ query: { importId: '../../etc/passwd' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('rejects an empty importId', async () => {
    const res = makeRes();
    await captured.put!(makeReq({ query: {} }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('403s when the ability check fails', async () => {
    const res = makeRes();
    await captured.put!(makeReq({ canCreate: false }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('writes under notebooks/<userId>/<importId>.json, ignoring anything else client-supplied', async () => {
    const res = makeRes();
    await captured.put!(makeReq({ userId: 'user-1', query: { importId: '1700000000000' } }), res);

    expect(uploadMock).toHaveBeenCalledTimes(1);
    const key = uploadMock.mock.calls[0][1] as string;
    expect(key).toBe('notebooks/user-1/1700000000000.json');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('413s a body over the cap without uploading anything', async () => {
    // The cap-crossing byte math is proven on real bytes in spoolRequestToFile.test.ts. Feeding
    // a real 101 MB here would only re-prove that, at the cost of writing it to the runner's
    // temp disk on every shard - so the route's error translation is what gets asserted.
    spoolMock.mockRejectedValueOnce(new UploadTooLargeError(MAX_NOTEBOOK_IMPORT_UPLOAD_BYTES));
    const res = makeRes();
    await captured.put!(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ maxBytes: MAX_NOTEBOOK_IMPORT_UPLOAD_BYTES }));
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('tears the socket down with a FIN after the 413 flushes, never an RST', async () => {
    // Measured against real sockets: destroying the request discards the queued response, so the
    // client gets ECONNRESET instead of the size message. Ending after 'finish' delivers it.
    spoolMock.mockRejectedValueOnce(new UploadTooLargeError(MAX_NOTEBOOK_IMPORT_UPLOAD_BYTES));
    const res = makeRes();
    const req = makeReq();
    await captured.put!(req, res);
    expect(req.destroy).not.toHaveBeenCalled();
    expect(req.socket.end).toHaveBeenCalledTimes(1);
  });
});
