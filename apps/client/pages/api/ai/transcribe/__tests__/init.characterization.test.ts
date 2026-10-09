// @vitest-environment node
/**
 * Characterization tests for POST /api/ai/transcribe/init: pin the legacy request validation and
 * presigned-POST response shape. The credit precheck is pinned in init.test.ts. The AWS SDK, `sst` and the database are
 * mocked by module specifier so the mocks keep biting wherever the route's body lives.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockCreatePresignedPost } = vi.hoisted(() => ({
  mockCreatePresignedPost: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.post = (handler: unknown) => handler;
    return chain;
  },
}));
vi.mock('@aws-sdk/client-s3', () => ({ S3Client: class {} }));
vi.mock('@aws-sdk/s3-presigned-post', () => ({ createPresignedPost: mockCreatePresignedPost }));
vi.mock('sst', () => ({ Resource: { appFilesBucket: { name: 'test-bucket' } } }));
vi.mock('@server/utils/creditPreflight', () => ({
  assertPreflightCredits: async () => undefined,
  InsufficientCreditsPreflightError: class extends Error {},
}));

const { default: handler } = await import('../init');

const MAX_BYTES = 25 * 1024 * 1024;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function post(body: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user: { id: 'u1' }, logger });
  return { req, res };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- next-connect handlers are untyped at this seam
const call = (req: unknown, res: unknown) => (handler as any)(req, res);

async function rejection(run: Promise<unknown>) {
  try {
    await run;
  } catch (err) {
    return err as { statusCode?: number; message: string };
  }
  throw new Error('expected the handler to throw');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreatePresignedPost.mockResolvedValue({ url: 'https://bucket.example/', fields: { key: 'k', Policy: 'p' } });
});

describe('POST /api/ai/transcribe/init', () => {
  it('returns the presigned POST and a key under the caller prefix', async () => {
    const { req, res } = post({ mimeType: 'audio/mpeg', fileSize: 1000 });

    await call(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(Object.keys(body).sort()).toEqual(['fields', 'fileKey', 'url']);
    expect(body.url).toBe('https://bucket.example/');
    expect(body.fields).toEqual({ key: 'k', Policy: 'p' });
    expect(body.fileKey).toMatch(/^transcribe-uploads\/u1\/[0-9a-f-]+\.mp3$/);
    expect(mockCreatePresignedPost).toHaveBeenCalledWith(expect.anything(), {
      Bucket: 'test-bucket',
      Key: body.fileKey,
      Conditions: [
        ['content-length-range', 1, MAX_BYTES],
        ['eq', '$Content-Type', 'audio/mpeg'],
      ],
      Fields: { 'Content-Type': 'audio/mpeg' },
      Expires: 300,
    });
  });

  it.each([
    ['an unsupported type', { mimeType: 'video/mp4', fileSize: 1000 }],
    ['a size over the limit', { mimeType: 'audio/mpeg', fileSize: MAX_BYTES + 1 }],
    ['a missing size', { mimeType: 'audio/mpeg' }],
  ])('rejects %s with 400', async (_label, body) => {
    const { req, res } = post(body);

    const err = await rejection(call(req, res));

    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/^Invalid request: /);
    expect(mockCreatePresignedPost).not.toHaveBeenCalled();
  });
});
