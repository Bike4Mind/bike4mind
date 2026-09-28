import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope, QA_INGEST_USER_TAG } from '@bike4mind/common';

const { mockPresign } = vi.hoisted(() => ({ mockPresign: vi.fn() }));

// baseApi is stubbed (no auth chain); the real nextRouteForContract prelude and errorHandler run.
vi.mock('@server/middlewares/baseApi', () => import('@server/qa/testing/baseApiStub'));
vi.mock('@server/qa/storage', () => ({
  presignQaPut: (...a: unknown[]) => mockPresign(...a),
  getQaS3Client: () => ({}),
  getQaArtifactsBucketName: () => 'example-bucket',
}));

import handler from '../uploads';

const KEY = { keyId: 'k1', scopes: [ApiKeyScope.QA_INGEST] };
const OWNER = { id: 'svc', tags: [QA_INGEST_USER_TAG] };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const call = async (
  body: unknown,
  auth: { apiKeyInfo?: unknown; user?: unknown } = { apiKeyInfo: KEY, user: OWNER }
) => {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, auth, { logger });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { status: res._getStatusCode(), json: res._getJSONData() };
};

const body = {
  product: 'product-a',
  external_run_id: '100-1',
  files: [{ path: 'test-0/shot.png', kind: 'screenshot', content_type: 'image/png', bytes: 100 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPresign.mockResolvedValue('https://s3.example/signed');
});

describe('POST /api/v1/qa/uploads', () => {
  it('returns presigned URLs bound to size and type', async () => {
    const { status, json } = await call(body);
    expect(status).toBe(200);
    expect(json.uploads).toEqual([
      { path: 'test-0/shot.png', key: 'product-a/100-1/media/test-0/shot.png', url: 'https://s3.example/signed' },
    ]);
    expect(mockPresign).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: 'example-bucket',
        key: 'product-a/100-1/media/test-0/shot.png',
        contentType: 'image/png',
        bytes: 100,
      })
    );
    // The contract's response drift check stays quiet.
    expect(logger.warn).not.toHaveBeenCalled();
  });
  it('403s a key without the scope', async () => {
    const { status } = await call(body, { apiKeyInfo: { keyId: 'k', scopes: [ApiKeyScope.AI_CHAT] }, user: OWNER });
    expect(status).toBe(403);
    expect(mockPresign).not.toHaveBeenCalled();
  });
  it('422s and names the field on a bad body', async () => {
    const { status, json } = await call({ ...body, product: 'Product A' });
    expect(status).toBe(422);
    expect(json.error).toContain('product');
  });
});
