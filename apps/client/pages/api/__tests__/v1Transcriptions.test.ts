// @vitest-environment node
/**
 * Route tests for POST /api/v1/transcriptions/uploads and POST /api/v1/transcriptions: the snake_case
 * mapping and how each transcribe helper rejection maps onto the CONVENTIONS.md status table. The
 * helpers' own behaviour is pinned through the SPA routes in pages/api/ai/transcribe/__tests__.
 * Scope enforcement through the real auth chain lives in
 * pages/api/v1/transcriptions/__tests__/scopes.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import {
  ApiKeyScope,
  TranscriptionResponseSchema,
  TranscriptionUploadResponseSchema,
  createTranscriptionContract,
  createTranscriptionUploadContract,
} from '@bike4mind/common';

const { mockCreateUpload, mockTranscribe } = vi.hoisted(() => ({
  mockCreateUpload: vi.fn(),
  mockTranscribe: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  methodNotAllowedHandler: () => (_req: unknown, res: { status: (n: number) => { end: () => void } }) =>
    res.status(405).end(),
  baseApi: () => {
    const compose =
      (...handlers: ((req: unknown, res: unknown, next: () => void) => unknown)[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of handlers) {
          let advanced = false;
          await handler(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      };
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.get = compose;
    chain.post = compose;
    chain.patch = compose;
    chain.delete = compose;
    return chain;
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: () => 60 }));
vi.mock('@server/transcribe/transcribe', async () => {
  const { BadRequestError } = await import('@server/utils/errors');
  class TranscribeRequestError extends BadRequestError {
    constructor(
      public kind: string,
      message: string
    ) {
      super(message);
    }
  }
  return {
    TranscribeRequestError,
    PRESIGNED_POST_EXPIRY_SECONDS: 300,
    createTranscribeUpload: mockCreateUpload,
    transcribeUpload: mockTranscribe,
  };
});

const { TranscribeRequestError } = (await import('@server/transcribe/transcribe')) as unknown as {
  TranscribeRequestError: new (kind: string, message: string) => Error;
};
const { default: uploadHandler } = await import('@pages/api/v1/transcriptions/uploads');
const { default: transcribeHandler } = await import('@pages/api/v1/transcriptions/index');

const KEY = 'transcribe-uploads/u1/abc.mp3';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() };

function post(body: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user: { id: 'u1' }, logger });
  return { req, res };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- next-connect handlers are untyped at this seam
const call = (handler: unknown, req: unknown, res: unknown) => (handler as any)(req, res);

async function rejection(run: Promise<unknown>) {
  try {
    await run;
  } catch (err) {
    return err as { statusCode?: number; message: string; additionalInfo?: Record<string, unknown> };
  }
  throw new Error('expected the handler to throw');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateUpload.mockResolvedValue({ url: 'https://bucket.example/', fields: { key: KEY }, fileKey: KEY });
  mockTranscribe.mockResolvedValue({ text: 'hello world' });
});

describe('transcription contracts', () => {
  it('require ai:generate', () => {
    expect(createTranscriptionUploadContract.scopes).toEqual([ApiKeyScope.AI_GENERATE]);
    expect(createTranscriptionContract.scopes).toEqual([ApiKeyScope.AI_GENERATE]);
  });

  it('document the request timeout limit', () => {
    expect(createTranscriptionContract.description).toMatch(/60 seconds/);
    expect(createTranscriptionContract.description).toMatch(/deleted either way/);
  });
});

describe('POST /api/v1/transcriptions/uploads', () => {
  it('returns 201 with the presigned upload and its expiry', async () => {
    const before = Date.now();
    const { req, res } = post({ mime_type: 'audio/mpeg', file_size: 1000 });

    await call(uploadHandler, req, res);

    expect(res._getStatusCode()).toBe(201);
    const body = res._getJSONData();
    expect(TranscriptionUploadResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ upload_url: 'https://bucket.example/', upload_fields: { key: KEY }, file_key: KEY });
    expect(Date.parse(body.expires_at)).toBeGreaterThanOrEqual(before + 300_000);
    expect(Date.parse(body.expires_at)).toBeLessThanOrEqual(Date.now() + 300_000);
    expect(mockCreateUpload).toHaveBeenCalledWith({ userId: 'u1', mimeType: 'audio/mpeg' });
  });

  it.each([
    ['an unsupported type', { mime_type: 'video/mp4', file_size: 1000 }],
    ['a size over the limit', { mime_type: 'audio/mpeg', file_size: 25 * 1024 * 1024 + 1 }],
    ['a camelCase field', { mimeType: 'audio/mpeg', fileSize: 1000 }],
  ])('rejects %s before minting anything', async (_label, body) => {
    const { req, res } = post(body);

    await expect(call(uploadHandler, req, res)).rejects.toThrow();
    expect(mockCreateUpload).not.toHaveBeenCalled();
  });

  it('answers insufficient credits with 422 insufficient_credits', async () => {
    mockCreateUpload.mockRejectedValue(new TranscribeRequestError('insufficient_credits', 'Insufficient credits'));
    const { req, res } = post({ mime_type: 'audio/mpeg', file_size: 1000 });

    const err = await rejection(call(uploadHandler, req, res));

    expect(err.statusCode).toBe(422);
    expect(err.additionalInfo).toEqual({ errorCode: 'insufficient_credits' });
  });
});

describe('POST /api/v1/transcriptions', () => {
  it('returns { text }', async () => {
    const { req, res } = post({ file_key: KEY });

    await call(transcribeHandler, req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ text: 'hello world' });
    expect(TranscriptionResponseSchema.safeParse(res._getJSONData()).success).toBe(true);
    expect(mockTranscribe).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', fileKey: KEY }));
  });

  it('rejects an unknown body field before transcribing', async () => {
    const { req, res } = post({ fileKey: KEY });

    await expect(call(transcribeHandler, req, res)).rejects.toThrow();
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid_key', 404, undefined],
    ['not_found', 404, undefined],
    ['unsupported_type', 422, undefined],
    ['size_out_of_range', 422, undefined],
    ['insufficient_credits', 422, 'insufficient_credits'],
    ['not_configured', 503, 'provider_not_configured'],
    ['user_not_found', 401, undefined],
  ])('maps a %s rejection to %i', async (kind, status, errorCode) => {
    mockTranscribe.mockRejectedValue(new TranscribeRequestError(kind, 'rejected'));
    const { req, res } = post({ file_key: KEY });

    const err = await rejection(call(transcribeHandler, req, res));

    expect(err.statusCode).toBe(status);
    expect(err.additionalInfo?.errorCode).toBe(errorCode);
  });

  it('wraps only a provider failure as 502', async () => {
    const { req, res } = post({ file_key: KEY });
    await call(transcribeHandler, req, res);
    const { mapProviderError } = mockTranscribe.mock.calls[0][0];

    expect((mapProviderError(new Error('boom')) as { statusCode: number }).statusCode).toBe(502);
  });

  it('passes any other failure through unchanged', async () => {
    const failure = new Error('db down');
    mockTranscribe.mockRejectedValue(failure);
    const { req, res } = post({ file_key: KEY });

    expect(await rejection(call(transcribeHandler, req, res))).toBe(failure);
  });
});
