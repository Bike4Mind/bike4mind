import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLoad = vi.fn();
const mockFindOneAndUpdate = vi.fn();
const mockUpdateOne = vi.fn();
const mockDownload = vi.fn();
const mockUpload = vi.fn();
const refund = vi.fn();

vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: {
    findOne: () => ({ lean: () => Promise.resolve(mockLoad()) }),
    findOneAndUpdate: (...a: unknown[]) => Promise.resolve(mockFindOneAndUpdate(...a)),
    updateOne: (...a: unknown[]) => Promise.resolve(mockUpdateOne(...a)),
  },
}));
vi.mock('@bike4mind/server-utils/services/publish/currentIndex', () => ({
  downloadPublishedIndex: async () => Buffer.from('<p>current</p>'),
  deleteRetiredPublishedIndex: async () => undefined,
  publishedContentSnapshotFilter: () => ({}),
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getPublishedArtifactsStorage: () => ({ download: mockDownload, upload: mockUpload }),
}));
vi.mock('@bike4mind/server-utils/utils/publishThumbnails', () => ({ enqueuePublishThumbnail: async () => undefined }));
vi.mock('@server/services/publish', () => ({
  validateBundle: () => ({ valid: true, violations: [] }),
  buildPublishUrlPath: () => '/p/u/slug',
  invalidatePublishCdn: async () => undefined,
  toCacheTarget: (a: unknown) => a,
  checkInPlaceRewriteQuota: async () => ({ ok: true }),
  consumePublishAction: async () => ({ refund }),
}));
vi.mock('@server/services/publish/planPublishVersions', () => ({
  planPublishVersions: () => ({ versionsToPush: [] }),
  versionsPushUpdate: () => ({}),
}));

import { restorePublishedVersion } from './restorePublishedVersion';
import { PublishServiceError } from './publishServiceError';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const base = { user: { id: 'owner1' }, logger: logger as never, publicId: 'pub1' };
const artifact = (extra: Record<string, unknown> = {}) => ({
  publicId: 'pub1',
  tier: 'user',
  scopeId: 'owner1',
  slug: 'slug',
  visibility: 'link',
  ownerId: 'owner1',
  storageKeyPrefix: 'k/',
  sha256Index: 'cur',
  size: { totalBytes: 10, fileCount: 1 },
  manifest: [{ path: 'index.html', size: 10, mimeType: 'text/html', sha256: 'cur' }],
  publishedAt: new Date(),
  source: { kind: 'bundle' },
  previousVersionMeta: { sha256Index: 'old' },
  versions: [{ sha256Index: 'old' }],
  ...extra,
});

async function refusal(promise: Promise<unknown>): Promise<PublishServiceError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(PublishServiceError);
  return error as PublishServiceError;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoad.mockResolvedValue(artifact());
  mockFindOneAndUpdate.mockResolvedValue({});
  mockUpdateOne.mockResolvedValue({ matchedCount: 1 });
  mockDownload.mockResolvedValue(Buffer.from('<p>old</p>'));
  mockUpload.mockResolvedValue(undefined);
});

describe('restorePublishedVersion', () => {
  it('restores the previous version and releases the lock', async () => {
    const restored = await restorePublishedVersion(base);
    expect(restored).toMatchObject({
      publicId: 'pub1',
      url: '/p/u/slug',
      restoredFrom: 'old',
      previousSha256Index: 'cur',
    });
    expect(restored.publishedAt).toBeInstanceOf(Date);
    expect(mockUpdateOne).toHaveBeenLastCalledWith(expect.anything(), { $set: { revisingAt: null } });
  });

  it.each([
    ['missing id', { publicId: '' }, null, 400],
    ['unknown artifact', {}, null, 404],
    ['non-owner', { user: { id: 'other' } }, artifact(), 403],
    ['non-bundle', {}, artifact({ source: { kind: 'reply' } }), 400],
    ['no anchor', {}, artifact({ sha256Index: undefined }), 409],
    ['unknown requested sha', { sha: 'zzz' }, artifact(), 400],
    ['no previous', {}, artifact({ previousVersionMeta: undefined }), 400],
  ])('refuses %s', async (_name, input, loaded, status) => {
    mockLoad.mockResolvedValue(loaded);
    expect((await refusal(restorePublishedVersion({ ...base, ...input }))).statusCode).toBe(status);
  });

  it('refuses while another revision holds the lock', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    expect((await refusal(restorePublishedVersion(base))).statusCode).toBe(409);
  });

  it('reports an unavailable archive as 409 and still frees the lock', async () => {
    mockDownload.mockRejectedValue(new Error('missing'));
    expect((await refusal(restorePublishedVersion(base))).statusCode).toBe(409);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { publicId: 'pub1', revisingAt: expect.any(Date) },
      { $set: { revisingAt: null } }
    );
  });

  it('refunds the action when the page was never written', async () => {
    mockUpload.mockRejectedValue(new Error('s3 down'));
    await expect(restorePublishedVersion(base)).rejects.toThrow('s3 down');
    expect(refund).toHaveBeenCalled();
  });
});
