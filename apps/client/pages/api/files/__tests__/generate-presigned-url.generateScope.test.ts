import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenError } from '@bike4mind/common';

/**
 * An ai:generate key without files:write may stage only a bare PNG (the image-edit flow), marked so
 * the file can be read back by that key alone. Keys holding files:write and JWT callers are unchanged.
 */
const h = vi.hoisted(() => ({ createFabFile: vi.fn(), getSignedUrl: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({ baseApi: () => ({ post: (fn: unknown) => fn }) }));
vi.mock('sst', () => ({ Resource: { fabFileBucket: { name: 'test-bucket' } } }));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {},
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: h.getSignedUrl }));
vi.mock('@server/managers/fabFileManager', () => ({ createFabFile: h.createFabFile }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: vi.fn() },
  scopedSettingsRepository: { findOverrides: vi.fn() },
  dataLakeRepository: { findByDatalakeTag: vi.fn(), find: vi.fn().mockResolvedValue([]) },
  dataLakeBatchRepository: { findById: vi.fn() },
  dataLakeAccessGrantRepository: { listByLake: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({
  toAccessContext: vi.fn(async (req: { user: { id: string } }) => ({
    userId: req.user.id,
    isAdmin: false,
    userTags: [],
    entitlementKeys: [],
    administeredOrgIds: [],
  })),
}));
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getSettingsMap: vi.fn(async () => ({})) };
});

import handler from '../generate-presigned-url';
import { BARE_UPLOAD_MAX_BYTES } from '@server/files/bareGenerateUpload';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
const run = (body: unknown, apiKeyInfo?: { scopes: string[] }) =>
  (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
    { method: 'POST', user: { id: 'u1', isAdmin: false }, ability: {}, body, apiKeyInfo, logger: { warn: vi.fn() } },
    makeRes().res
  );

const generateOnly = { scopes: ['ai:generate'] };
const png = (extra: Record<string, unknown> = {}) => ({
  fileName: 'mask.png',
  mimeType: 'image/png',
  fileSize: 1024,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.createFabFile.mockResolvedValue({ id: 'f1' });
  h.getSignedUrl.mockResolvedValue('https://s3.test/put');
});

const signedInput = () => (h.getSignedUrl.mock.calls[0][1] as { input: Record<string, unknown> }).input;

describe('POST /api/files/generate-presigned-url - ai:generate-only key', () => {
  it('admits a bare PNG upload and marks the file', async () => {
    const { res, json } = makeRes();
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
      {
        method: 'POST',
        user: { id: 'u1' },
        ability: {},
        body: png(),
        apiKeyInfo: generateOnly,
        logger: { warn: vi.fn() },
      },
      res
    );
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'f1', url: 'https://s3.test/put' }));
    expect(h.createFabFile.mock.calls[0][0]).toMatchObject({
      mimeType: 'image/png',
      sourceMetadata: { uploadedVia: 'ai-generate-key-upload' },
    });
    expect(h.createFabFile.mock.calls[0][0].tags).toBeUndefined();
  });

  it.each([
    ['tags', { tags: [{ name: 'a', strength: 1 }] }],
    ['batchId', { batchId: 'b1' }],
    ['path', { path: 'x/y' }],
    ['relativePath', { relativePath: 'x/y.png' }],
    ['contentHash', { contentHash: 'abc' }],
    ['a field the schema does not know', { visibility: 'public' }],
    ['a mime type other than png', { mimeType: 'image/jpeg', fileName: 'a.jpg' }],
    ['a non-image mime type', { mimeType: 'text/plain', fileName: 'a.txt' }],
    ['a png claim on a non-png extension', { fileName: 'a.html' }],
    ['a size above the cap', { fileSize: BARE_UPLOAD_MAX_BYTES + 1 }],
    ['a zero size', { fileSize: 0 }],
    ['a fractional size', { fileSize: 10.5 }],
    ['a string size', { fileSize: '10' }],
    ['an overlong name', { fileName: `${'a'.repeat(260)}.png` }],
  ])('403s naming files:write for %s', async (_name, extra) => {
    const err = await run(png(extra), generateOnly).catch(e => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toMatch(/files:write is required/);
    expect(h.createFabFile).not.toHaveBeenCalled();
  });

  it('403s a non-object body', async () => {
    const err = await run('x', generateOnly).catch(e => e);
    expect(err).toBeInstanceOf(ForbiddenError);
  });

  it('binds the presigned PUT to image/png and the declared length', async () => {
    await run(png({ fileSize: 2048 }), generateOnly);
    expect(signedInput()).toMatchObject({ ContentType: 'image/png', ContentLength: 2048 });
    const options = h.getSignedUrl.mock.calls[0][2] as { signableHeaders?: Set<string> };
    expect(options.signableHeaders?.has('content-type')).toBe(true);
  });

  it('makes the presigned PUT create-only', async () => {
    await run(png({ fileSize: 2048 }), generateOnly);
    expect(signedInput()).toMatchObject({ IfNoneMatch: '*' });
  });

  it('admits a png exactly at the cap', async () => {
    await run(png({ fileSize: BARE_UPLOAD_MAX_BYTES }), generateOnly);
    expect(h.createFabFile).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/files/generate-presigned-url - callers that keep today behaviour', () => {
  it('lets a files:write key attach tags and upload any supported type, unmarked', async () => {
    await run(
      {
        fileName: 'r.txt',
        mimeType: 'text/plain',
        fileSize: BARE_UPLOAD_MAX_BYTES + 1,
        tags: [{ name: 'a', strength: 1 }],
      },
      { scopes: ['files:write', 'ai:generate'] }
    );
    const persisted = h.createFabFile.mock.calls[0][0];
    expect(persisted.tags).toEqual([{ name: 'a', strength: 1 }]);
    expect(persisted.sourceMetadata).toBeUndefined();
    expect(Object.keys(signedInput()).sort()).toEqual(['Bucket', 'Key']);
  });

  it('lets a JWT caller (no apiKeyInfo) upload a non-png, unmarked', async () => {
    await run({ fileName: 'r.txt', mimeType: 'text/plain', fileSize: 10 });
    expect(h.createFabFile.mock.calls[0][0].sourceMetadata).toBeUndefined();
    expect(Object.keys(signedInput()).sort()).toEqual(['Bucket', 'Key']);
  });
});
