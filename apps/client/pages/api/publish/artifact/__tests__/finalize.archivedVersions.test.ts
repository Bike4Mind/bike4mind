import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createMocks } from 'node-mocks-http';
import { PUBLISH_QUOTAS } from '@bike4mind/common';

// A re-publish archives the page's previous index.html under versions/, and those archived bytes
// count toward the storage quota. The real checkPublishQuota runs against a stubbed usage
// aggregate, so the archived-bytes math is what is under test, not a mock of it.

const m = vi.hoisted(() => ({
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  aggregate: vi.fn(),
  download: vi.fn(),
  upload: vi.fn(),
}));

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
  getPublishedArtifactsStorage: () => ({ download: m.download, upload: m.upload, delete: () => Promise.resolve() }),
}));
vi.mock('@bike4mind/server-utils/utils/publishThumbnails', () => ({
  enqueuePublishThumbnail: () => Promise.resolve(),
}));
vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: {
    findOne: () => ({ select: () => ({ lean: () => Promise.resolve(m.findOne()) }) }),
    findOneAndUpdate: (...a: unknown[]) => Promise.resolve(m.findOneAndUpdate(...a)),
    aggregate: (...a: unknown[]) => m.aggregate(...a),
  },
}));
vi.mock('@server/services/publish', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    checkScopePermission: () => Promise.resolve({ ok: true }),
    resolveVisibility: (_tier: string, visibility: string) => ({ ok: true, visibility }),
    buildPublishS3KeyPrefix: () => PREFIX,
    buildPublishUrlPath: () => '/p/u/owner1/art',
    invalidatePublishCdn: () => Promise.resolve(),
    toCacheTarget: () => ({}),
    mintDraftUploadUrl: () => Promise.resolve('https://example.invalid/put'),
    consumePublishAction: () => Promise.resolve({ refund: () => Promise.resolve() }),
  };
});

import finalizeHandler from '../finalize';
import uploadUrlHandler from '../upload-url';

const USER_CAP = PUBLISH_QUOTAS.user.maxTotalBytes;
const DRAFT_ID = '55555555-5555-4555-8555-555555555555';
const PREFIX = 'user/owner1/art/';
const OLD = '<!doctype html><html><head></head><body><h1>Old version</h1></body></html>';
const NEW = '<!doctype html><html><head></head><body><h1>New version, a little longer</h1></body></html>';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const draft = {
  source: { kind: 'bundle' },
  draftId: DRAFT_ID,
  createdAt: '2026-10-01T00:00:00.000Z',
  createdBy: 'owner1',
  tier: 'user',
  scopeId: 'owner1',
  slug: 'art',
  title: 'Art',
  visibility: 'private',
  files: [{ path: 'index.html', size: NEW.length, mimeType: 'text/html' }],
};

/** The draft uploads NEW; the live page's index.html holds `live`. */
const storageHolds = (live: string) =>
  m.download.mockImplementation((key: string) => {
    if (key.endsWith('_manifest.json')) return Promise.resolve(Buffer.from(JSON.stringify(draft)));
    if (key === `${PREFIX}index.html`) return Promise.resolve(Buffer.from(live));
    return Promise.resolve(Buffer.from(NEW));
  });

const previousPage = (over: Record<string, unknown> = {}) => ({
  publicId: 'pub1',
  publishedAt: new Date('2026-10-01T00:00:00.000Z'),
  ownerId: 'owner1',
  size: { totalBytes: OLD.length, fileCount: 1 },
  sha256Index: sha(OLD),
  versions: [{ sha256Index: sha(OLD), indexBytes: OLD.length }],
  visibility: 'private',
  ...over,
});

/** The owner's OTHER pages (this one is excluded from usage) leave exactly `room` bytes free. */
const otherPagesLeave = (room: number) => m.aggregate.mockResolvedValue([{ totalBytes: USER_CAP - room }]);

const post = (handler: unknown, body: unknown) => {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req as Record<string, unknown>, {
    user: { id: 'owner1', isAdmin: false, organizationId: null },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  });
  return { res, promise: (handler as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};
const finalize = async () => {
  const { res, promise } = post(finalizeHandler, { draftId: DRAFT_ID });
  await promise;
  return res;
};

const pushedVersions = () =>
  (m.findOneAndUpdate.mock.calls[0][1] as { $push: { versions: { $each: Array<Record<string, unknown>> } } }).$push
    .versions.$each;
const archiveWrites = () => m.upload.mock.calls.filter(c => String(c[1]).startsWith(`${PREFIX}versions/`));

beforeEach(() => {
  vi.clearAllMocks();
  m.findOne.mockReturnValue(previousPage());
  m.findOneAndUpdate.mockReturnValue({ visibility: 'private', publicId: 'pub1' });
  m.aggregate.mockResolvedValue([{ totalBytes: 0 }]);
  m.upload.mockResolvedValue(undefined);
  storageHolds(OLD);
});

describe('finalize - archived versions', () => {
  it('records indexBytes on the new version, and on a replaced version history did not have yet', async () => {
    m.findOne.mockReturnValue(previousPage({ versions: [] }));

    const res = await finalize();

    expect(res._getStatusCode()).toBe(200);
    expect(pushedVersions()).toEqual([
      expect.objectContaining({ sha256Index: sha(OLD), indexBytes: OLD.length }),
      expect.objectContaining({ sha256Index: sha(NEW), indexBytes: NEW.length }),
    ]);
    // The recorded byte count is that of the buffer actually archived.
    expect(archiveWrites()).toHaveLength(1);
    expect(archiveWrites()[0][1]).toBe(`${PREFIX}versions/${sha(OLD)}.html`);
    expect((archiveWrites()[0][0] as Buffer).length).toBe(OLD.length);
  });

  it('records a first publish with its indexBytes and archives nothing', async () => {
    m.findOne.mockReturnValue(null);

    const res = await finalize();

    expect(res._getStatusCode()).toBe(200);
    expect(pushedVersions()).toEqual([expect.objectContaining({ sha256Index: sha(NEW), indexBytes: NEW.length })]);
    expect(archiveWrites()).toHaveLength(0);
  });

  it('counts the version a re-publish archives: fits exactly, refused one byte past the cap', async () => {
    otherPagesLeave(NEW.length + OLD.length);
    expect((await finalize())._getStatusCode()).toBe(200);
    const [pipeline] = m.aggregate.mock.calls[0] as [Array<{ $match?: Record<string, unknown> }>];
    expect(pipeline[0].$match).toMatchObject({ $nor: [{ tier: 'user', scopeId: 'owner1', slug: 'art' }] });

    vi.clearAllMocks();
    m.findOneAndUpdate.mockReturnValue({ visibility: 'private', publicId: 'pub1' });
    otherPagesLeave(NEW.length + OLD.length - 1);

    const res = await finalize();

    expect(res._getStatusCode()).toBe(413);
    expect(res._getJSONData()).toMatchObject({
      code: 'quota_bytes_exceeded',
      details: { scope: 'user', limit: USER_CAP, attempted: USER_CAP + 1 },
    });
    expect(m.findOneAndUpdate).not.toHaveBeenCalled();
    expect(m.upload).not.toHaveBeenCalled();
  });

  it('keeps earlier archived versions in the count and adds nothing for an identical re-publish', async () => {
    const earlier = { sha256Index: 'sha-earlier', indexBytes: 300 };
    m.findOne.mockReturnValue(
      previousPage({
        size: { totalBytes: NEW.length, fileCount: 1 },
        sha256Index: sha(NEW),
        versions: [earlier, { sha256Index: sha(NEW), indexBytes: NEW.length }],
      })
    );
    storageHolds(NEW);
    // Room for the bundle and the earlier version, and nothing more: the unchanged page archives nothing new.
    otherPagesLeave(NEW.length + earlier.indexBytes);

    const res = await finalize();

    expect(res._getStatusCode()).toBe(200);
    expect(pushedVersions()).toEqual([]);
  });

  it('counts a legacy replaced version (no indexBytes) as 0', async () => {
    m.findOne.mockReturnValue(previousPage({ versions: [{ sha256Index: sha(OLD) }] }));
    otherPagesLeave(NEW.length);

    const res = await finalize();

    expect(res._getStatusCode()).toBe(200);
    expect(pushedVersions()).toEqual([expect.objectContaining({ sha256Index: sha(NEW), indexBytes: NEW.length })]);
  });
});

describe('upload-url - archived versions', () => {
  const uploadBody = {
    tier: 'user',
    scopeId: 'owner1',
    slug: 'art',
    title: 'Art',
    files: [{ path: 'index.html', size: NEW.length, mimeType: 'text/html' }],
  };
  const requestUrls = async () => {
    const { res, promise } = post(uploadUrlHandler, uploadBody);
    await promise;
    return res;
  };

  it("adds the page's archived versions back to usage, but not its current one", async () => {
    m.findOne.mockReturnValue(
      previousPage({ versions: [{ sha256Index: 'sha-earlier', indexBytes: 300 }, ...previousPage().versions] })
    );

    otherPagesLeave(NEW.length + 300);
    expect((await requestUrls())._getStatusCode()).toBe(200);

    otherPagesLeave(NEW.length + 299);
    const res = await requestUrls();
    expect(res._getStatusCode()).toBe(413);
    expect(res._getJSONData().details).toMatchObject({ attempted: USER_CAP + 1 });
  });
});
