import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { BadGatewayError, BadRequestError, NotFoundError } from '@bike4mind/common';

/**
 * A missing or unreadable file is the caller's problem, so it must surface as a 4xx that
 * `errorHandler` logs at warn; only a failed storage download is a server-side fault.
 */

// any: the handler is captured from a mocked baseApi chain, so express req/res are not typed here
const mockRefs = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@client/server/middlewares/baseApi', () => ({
  baseApi: () => {
    // any: minimal stand-in for the baseApi router chain
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const chain: any = {
      use: () => chain,
      post: (fn: any) => {
        mockRefs.handler = fn;
        return chain;
      },
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return chain;
  },
}));

const findById = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({ fabFileRepository: { findById } }));

const axiosGet = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({ default: { get: axiosGet } }));

import '../proxy-fabfile-image';

function request(body: unknown) {
  const { req, res } = createMocks({ method: 'POST', body });
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  (req as unknown as { user: unknown }).user = { id: 'u1' };
  (req as unknown as { logger: unknown }).logger = logger;
  return { req, res, logger };
}

const ownImage = {
  userId: 'u1',
  mimeType: 'image/png',
  fileName: 'a.png',
  fileUrl: 'https://storage.example.com/a.png',
  moderationStatus: 'clean',
};

describe('POST /api/blog/proxy-fabfile-image', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('answers a missing file with NotFoundError and logs nothing at error', async () => {
    findById.mockResolvedValue(null);
    const { req, res, logger } = request({ fabFileId: 'missing' });

    await expect(mockRefs.handler!(req, res)).rejects.toBeInstanceOf(NotFoundError);
    expect(logger.error).not.toHaveBeenCalled();
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it("answers another user's private file exactly like a missing one", async () => {
    findById.mockResolvedValue({ ...ownImage, userId: 'someone-else', public: false, isGlobalRead: false });
    const { req, res, logger } = request({ fabFileId: 'f1' });

    await expect(mockRefs.handler!(req, res)).rejects.toThrow(new NotFoundError('FabFile not found'));
    expect(logger.error).not.toHaveBeenCalled();
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('serves a public image owned by someone else', async () => {
    findById.mockResolvedValue({ ...ownImage, userId: 'someone-else', public: true });
    axiosGet.mockResolvedValue({ data: Buffer.from('png'), headers: {} });
    const { req, res } = request({ fabFileId: 'f1' });

    await mockRefs.handler!(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ success: true, mimeType: 'image/png' });
  });

  it('answers a held or blocked image like a missing one without downloading it', async () => {
    findById.mockResolvedValue({ ...ownImage, moderationStatus: 'blocked' });
    const { req, res } = request({ fabFileId: 'f1' });

    await expect(mockRefs.handler!(req, res)).rejects.toThrow(new NotFoundError('FabFile not found'));
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('rejects a missing fabFileId as a bad request', async () => {
    const { req, res } = request({});

    await expect(mockRefs.handler!(req, res)).rejects.toBeInstanceOf(BadRequestError);
    expect(findById).not.toHaveBeenCalled();
  });

  it('rejects a file with no stored url as a bad request', async () => {
    findById.mockResolvedValue({ ...ownImage, fileUrl: undefined });
    const { req, res } = request({ fabFileId: 'f1' });

    await expect(mockRefs.handler!(req, res)).rejects.toBeInstanceOf(BadRequestError);
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('rejects a non-image file as a bad request', async () => {
    findById.mockResolvedValue({ ...ownImage, mimeType: 'application/pdf' });
    const { req, res } = request({ fabFileId: 'f1' });

    await expect(mockRefs.handler!(req, res)).rejects.toBeInstanceOf(BadRequestError);
  });

  it('turns a storage download failure into a generic 502 without leaking the upstream message', async () => {
    findById.mockResolvedValue(ownImage);
    axiosGet.mockRejectedValue(new Error('connect ECONNREFUSED internal-host'));
    const { req, res, logger } = request({ fabFileId: 'f1' });

    const error = await Promise.resolve(mockRefs.handler!(req, res)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadGatewayError);
    expect((error as BadGatewayError).message).not.toContain('ECONNREFUSED');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });
});
