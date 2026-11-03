import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@server/auth/assertOutboundActionAllowed', () => ({
  outboundActionGate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  assertOutboundActionAllowed: async () => undefined,
}));
import { createMocks } from 'node-mocks-http';
import { TooManyRequestsError } from '@bike4mind/common';

/**
 * The daily publish allowance on the bundle flow, driven through BOTH real handlers: upload-url
 * counts one action per bundle publish, finalize never counts (it only promotes a draft a counted
 * upload-url issued), so a full upload-url -> finalize publish is charged exactly once.
 */

const { mockFindOne, mockFindOneAndUpdate, mockDownload, mockUpload, mockConsume, mockRefund, mockQuota } = vi.hoisted(
  () => ({
    mockFindOne: vi.fn(),
    mockFindOneAndUpdate: vi.fn(),
    mockDownload: vi.fn(),
    mockUpload: vi.fn(),
    mockConsume: vi.fn(),
    mockRefund: vi.fn(),
    mockQuota: vi.fn(),
  })
);

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.POST = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getPublishedArtifactsStorage: () => ({
    download: mockDownload,
    upload: mockUpload,
    delete: vi.fn(() => Promise.resolve()),
  }),
}));

vi.mock('@bike4mind/server-utils/utils/publishThumbnails', () => ({
  enqueuePublishThumbnail: vi.fn(() => Promise.resolve()),
}));

vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: {
    findOne: () => ({ select: () => ({ lean: () => Promise.resolve(mockFindOne()) }) }),
    findOneAndUpdate: (...a: unknown[]) => Promise.resolve(mockFindOneAndUpdate(...a)),
  },
}));

vi.mock('@server/services/publish', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    validateBundle: () => ({ valid: true, violations: [] }),
    checkScopePermission: () => Promise.resolve({ ok: true }),
    checkPublishQuota: mockQuota,
    resolveVisibility: (_tier: string, visibility?: string) => ({ ok: true, visibility: visibility ?? 'private' }),
    buildPublishS3KeyPrefix: () => 'user/owner1/doc/',
    buildPublishUrlPath: () => '/p/u/owner1/doc',
    invalidatePublishCdn: () => undefined,
    toCacheTarget: () => ({}),
    mintDraftUploadUrl: () => Promise.resolve('https://example.invalid/put'),
    consumePublishAction: mockConsume,
  };
});

import finalizeHandler from '../finalize';
import uploadUrlHandler from '../upload-url';

const INDEX_HTML = '<html><head></head><body><h1>Hi</h1></body></html>';
const CREATED_AT = new Date('2026-10-20T00:00:00.000Z');
const OWNER = { id: 'owner1', isAdmin: false, organizationId: null, createdAt: CREATED_AT };

const post = (handler: unknown, body: unknown, extra: Record<string, unknown> = {}) => {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req as Record<string, unknown>, {
    user: OWNER,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ...extra,
  });
  return { res, promise: (handler as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const uploadBody = {
  tier: 'user',
  scopeId: 'owner1',
  slug: 'doc',
  title: 'My Artifact',
  files: [{ path: 'index.html', size: INDEX_HTML.length, mimeType: 'text/html' }],
};

const draftManifestUploads = () => mockUpload.mock.calls.filter(c => String(c[1]).endsWith('_manifest.json'));

beforeEach(() => {
  mockFindOne.mockReset().mockResolvedValue(null);
  mockFindOneAndUpdate.mockReset().mockResolvedValue({ visibility: 'private', publicId: 'pub1' });
  mockUpload.mockReset().mockResolvedValue(undefined);
  mockRefund.mockReset().mockResolvedValue(undefined);
  mockConsume.mockReset().mockResolvedValue({ refund: mockRefund });
  mockQuota.mockReset().mockResolvedValue({ ok: true });
  // finalize reads back the draft manifest upload-url wrote, then the uploaded index.html.
  mockDownload.mockReset().mockImplementation((key: string) => {
    if (!key.endsWith('_manifest.json')) return Promise.resolve(Buffer.from(INDEX_HTML));
    const manifest = draftManifestUploads()[0]?.[0];
    return manifest ? Promise.resolve(manifest) : Promise.reject(new Error('NoSuchKey'));
  });
});

describe('upload-url - daily publish allowance', () => {
  it('counts one action against the caller, with the account age that picks the tier', async () => {
    const { res, promise } = post(uploadUrlHandler, uploadBody);
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(mockConsume).toHaveBeenCalledTimes(1);
    expect(mockConsume).toHaveBeenCalledWith(expect.objectContaining({ id: 'owner1', createdAt: CREATED_AT }));
    expect(mockRefund).not.toHaveBeenCalled();
  });

  it('hands the action back when the draft cannot be issued', async () => {
    const storageDown = new Error('storage unavailable');
    mockUpload.mockRejectedValue(storageDown);

    const { promise } = post(uploadUrlHandler, uploadBody);

    await expect(promise).rejects.toBe(storageDown);
    expect(mockConsume).toHaveBeenCalledTimes(1);
    expect(mockRefund).toHaveBeenCalledTimes(1);
  });

  it("counts an API-key caller against the key owner's allowance", async () => {
    const { res, promise } = post(uploadUrlHandler, uploadBody, { apiKeyInfo: { keyId: 'key1', scopes: [] } });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(mockConsume).toHaveBeenCalledWith(expect.objectContaining({ id: 'owner1' }));
  });

  it('issues no draft and no upload URLs once the allowance is used up, and lets the 429 through', async () => {
    const limited = new TooManyRequestsError("You've published a lot today. Try again in 5 minutes.", {
      code: 'publish_rate_limited',
      retryAfter: 300,
    });
    mockConsume.mockRejectedValue(limited);

    const { promise } = post(uploadUrlHandler, uploadBody);

    await expect(promise).rejects.toBe(limited);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockRefund).not.toHaveBeenCalled();
  });

  it('does not count a publish the storage quota refused', async () => {
    mockQuota.mockResolvedValue({
      ok: false,
      status: 413,
      code: 'quota_bytes_exceeded',
      error: 'Publish storage quota reached',
      details: { scope: 'user', limit: 1, current: 1, attempted: 2 },
    });
    const { res, promise } = post(uploadUrlHandler, uploadBody);
    await promise;

    expect(res._getStatusCode()).toBe(413);
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it('does not count an invalid request', async () => {
    const { res, promise } = post(uploadUrlHandler, { ...uploadBody, files: [] });
    await promise;

    expect(res._getStatusCode()).toBe(400);
    expect(mockConsume).not.toHaveBeenCalled();
  });
});

describe('finalize - not counted again', () => {
  it('charges a full upload-url -> finalize bundle publish exactly once', async () => {
    const draft = post(uploadUrlHandler, uploadBody);
    await draft.promise;
    expect(draft.res._getStatusCode()).toBe(200);
    const { draftId } = draft.res._getJSONData() as { draftId: string };

    const finalize = post(finalizeHandler, { draftId });
    await finalize.promise;

    expect(finalize.res._getStatusCode()).toBe(200);
    expect(mockConsume).toHaveBeenCalledTimes(1);
  });

  it('never consults the allowance, even when it is used up', async () => {
    const draft = post(uploadUrlHandler, uploadBody);
    await draft.promise;
    const { draftId } = draft.res._getJSONData() as { draftId: string };
    mockConsume.mockReset().mockRejectedValue(new TooManyRequestsError('limited'));

    const finalize = post(finalizeHandler, { draftId });
    await finalize.promise;

    expect(finalize.res._getStatusCode()).toBe(200);
    expect(mockConsume).not.toHaveBeenCalled();
  });
});
