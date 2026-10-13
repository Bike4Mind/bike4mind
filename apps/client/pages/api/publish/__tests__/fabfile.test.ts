import { describe, it, expect, vi, beforeEach } from 'vitest';

// fabfile.ts wires an Express-style handler at module load and imports server-only deps; stub them
// so we can drive the handler (default export) in isolation. @bike4mind/common is NOT mocked - the
// handler relies on the real PublishFabFileRequestSchema + SupportedFabFileMimeTypes.
const mocks = vi.hoisted(() => ({
  fileLean: vi.fn(),
  publishedFindOneLean: vi.fn(),
  publishedFindOne: vi.fn(),
  invalidatePublishCdn: vi.fn(),
  findOneAndUpdate: vi.fn(),
  download: vi.fn(),
}));

// baseApi().post(fn) returns fn, so `export default handler` IS the handler function.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, { use: () => chain, post: (fn: unknown) => fn });
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  FabFile: { findById: () => ({ select: () => ({ lean: mocks.fileLean }) }) },
  PublishedArtifact: {
    findOne: (filter: unknown) => {
      mocks.publishedFindOne(filter);
      return { sort: () => ({ lean: mocks.publishedFindOneLean }) };
    },
    findOneAndUpdate: mocks.findOneAndUpdate,
  },
}));
vi.mock('@server/services/publish', () => ({
  resolveVisibility: (_tier: string, visibility?: string) => ({ ok: true, visibility: visibility ?? 'public' }),
  checkScopePermission: () => ({ ok: true }),
  checkPublishQuota: () => ({ ok: true }),
  invalidatePublishCdn: mocks.invalidatePublishCdn,
  restrictDuplicatePublications: vi.fn(),
  toCacheTarget: (a: { publicId: string }) => ({ publicId: a.publicId }),
}));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ download: mocks.download }),
}));

import handler from '../fabfile';

const OWNER = 'owner-user-id';

type Res = {
  statusCode: number;
  body: unknown;
  status: (code: number) => Res;
  json: (obj: unknown) => Res;
};
const makeRes = (): Res => {
  const res = { statusCode: 0, body: undefined as unknown } as Res;
  res.status = (code: number) => ((res.statusCode = code), res);
  res.json = (obj: unknown) => ((res.body = obj), res);
  return res;
};
const makeReq = () => ({
  user: { id: OWNER, isAdmin: false, organizationId: null, username: 'u' },
  body: { fabFileId: 'fab1', tier: 'user', visibility: 'public' },
  logger: { info: () => {} },
});
const run = (req: unknown) => {
  const res = makeRes();
  return (handler as (req: unknown, res: unknown) => Promise<void>)(req, res).then(() => res);
};

// The renderedBody the handler snapshotted, read off the findOneAndUpdate $set.
const snapshottedBody = (): string => {
  const [, update] = mocks.findOneAndUpdate.mock.calls[0];
  return (update as { $set: { renderedBody: string } }).$set.renderedBody;
};

describe('POST /api/publish/fabfile - body sourcing (#722)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.publishedFindOneLean.mockResolvedValue(null);
    mocks.findOneAndUpdate.mockResolvedValue({ publicId: 'f-abc', slug: 'f-abc' });
  });

  it('sources a text file body from S3 (filePath), not the empty file.text', async () => {
    mocks.fileLean.mockResolvedValue({
      userId: OWNER,
      moderationStatus: 'clean',
      fileName: 'notes.md',
      text: '', // "Save as Text" leaves this empty; real content is in S3
      mimeType: 'text/markdown',
      filePath: 'user/fab1/notes.md',
    });
    mocks.download.mockResolvedValue(Buffer.from('# Real content\nfrom S3', 'utf-8'));

    const res = await run(makeReq());
    expect(res.statusCode).toBe(200);
    expect(mocks.download).toHaveBeenCalledWith('user/fab1/notes.md');
    expect(snapshottedBody()).toBe('# Real content\nfrom S3');
  });

  it('falls back to file.text when the S3 download fails', async () => {
    mocks.fileLean.mockResolvedValue({
      userId: OWNER,
      moderationStatus: 'clean',
      mimeType: 'text/plain',
      text: 'already extracted text',
      filePath: 'user/fab1/x.txt',
    });
    mocks.download.mockRejectedValue(new Error('NoSuchKey'));

    const res = await run(makeReq());
    expect(res.statusCode).toBe(200);
    expect(snapshottedBody()).toBe('already extracted text');
  });

  it('rejects a non-text (binary) file with no extracted text (415)', async () => {
    mocks.fileLean.mockResolvedValue({
      userId: OWNER,
      moderationStatus: 'clean',
      mimeType: 'application/pdf',
      text: '',
      filePath: 'user/fab1/doc.pdf',
    });

    const res = await run(makeReq());
    expect(res.statusCode).toBe(415);
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('publishes a binary file using its already-extracted text when present', async () => {
    mocks.fileLean.mockResolvedValue({
      userId: OWNER,
      moderationStatus: 'clean',
      mimeType: 'application/pdf',
      text: 'text extracted from the pdf at ingest',
      filePath: 'user/fab1/doc.pdf',
    });

    const res = await run(makeReq());
    expect(res.statusCode).toBe(200);
    // Binary bytes are never decoded as UTF-8; the pre-extracted text is used verbatim.
    expect(mocks.download).not.toHaveBeenCalled();
    expect(snapshottedBody()).toBe('text extracted from the pdf at ingest');
  });

  it('rejects a text file whose S3 object is empty and has no fallback text (422)', async () => {
    mocks.fileLean.mockResolvedValue({
      userId: OWNER,
      moderationStatus: 'clean',
      mimeType: 'text/markdown',
      text: '',
      filePath: 'user/fab1/empty.md',
    });
    mocks.download.mockResolvedValue(Buffer.from('   \n', 'utf-8')); // 0-byte/whitespace-only object

    const res = await run(makeReq());
    expect(res.statusCode).toBe(422);
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects a text file that has neither filePath nor text (422)', async () => {
    mocks.fileLean.mockResolvedValue({
      userId: OWNER,
      moderationStatus: 'clean',
      mimeType: 'text/markdown',
      text: '',
    });

    const res = await run(makeReq());
    expect(res.statusCode).toBe(422);
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
  });

  // Hold-until-scanned: never publish (serve) a file that has not cleared moderation.
  it('refuses to publish a file still being scanned (409)', async () => {
    mocks.fileLean.mockResolvedValue({
      userId: OWNER,
      moderationStatus: 'pending',
      mimeType: 'text/markdown',
      text: 'content',
      filePath: 'user/fab1/notes.md',
    });

    const res = await run(makeReq());
    expect(res.statusCode).toBe(409);
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('refuses to publish a moderation-blocked file (403)', async () => {
    mocks.fileLean.mockResolvedValue({
      userId: OWNER,
      moderationStatus: 'blocked',
      mimeType: 'text/markdown',
      text: 'content',
      filePath: 'user/fab1/notes.md',
    });

    const res = await run(makeReq());
    expect(res.statusCode).toBe(403);
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('POST /api/publish/fabfile - re-publish updates the owner record in place', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fileLean.mockResolvedValue({ userId: OWNER, moderationStatus: 'clean', mimeType: 'text/plain', text: 'hi' });
    mocks.publishedFindOneLean.mockResolvedValue({
      _id: 'row1',
      publicId: 'live1',
      slug: 'f-live1',
      tier: 'user',
      scopeId: OWNER,
      visibility: 'public',
    });
    mocks.findOneAndUpdate.mockImplementation(async (_f: unknown, update: { $set: Record<string, unknown> }) => ({
      ...update.$set,
      source: { kind: 'fabfile' },
    }));
  });

  it('switching to Private rewrites the existing owner-scoped record and purges the CDN', async () => {
    const req = makeReq();
    req.body.visibility = 'private';
    const res = await run(req);
    expect(res.statusCode).toBe(200);
    expect(mocks.publishedFindOne).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER }));
    const [filter, update] = mocks.findOneAndUpdate.mock.calls[0] as [unknown, { $set: Record<string, unknown> }];
    expect(filter).toEqual({ _id: 'row1', ownerId: OWNER, deletedAt: null });
    expect(update.$set).toMatchObject({ publicId: 'live1', visibility: 'private' });
    expect(mocks.invalidatePublishCdn).toHaveBeenCalledWith({ publicId: 'live1' }, expect.anything());
  });

  it('answers 409, not a duplicate-key 500, when the page is removed between lookup and write', async () => {
    mocks.findOneAndUpdate.mockImplementation(async (_f: unknown, _u: unknown, opts: { upsert?: boolean }) => {
      if (opts.upsert) throw Object.assign(new Error('E11000 duplicate key error collection'), { code: 11000 });
      return null;
    });
    const res = await run(makeReq());
    expect(res.statusCode).toBe(409);
    expect(mocks.invalidatePublishCdn).not.toHaveBeenCalled();
  });
});
