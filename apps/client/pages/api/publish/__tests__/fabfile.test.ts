import { describe, it, expect, vi, beforeEach } from 'vitest';

// fabfile.ts wires an Express-style handler at module load and imports server-only deps; stub them
// so we can drive the handler (default export) in isolation. @bike4mind/common is NOT mocked - the
// handler relies on the real PublishFabFileRequestSchema + SupportedFabFileMimeTypes.
const mocks = vi.hoisted(() => ({
  fileLean: vi.fn(),
  publishedFindOneLean: vi.fn(),
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
    findOne: () => ({ lean: mocks.publishedFindOneLean }),
    findOneAndUpdate: mocks.findOneAndUpdate,
  },
}));
vi.mock('@server/services/publish', () => ({
  resolveVisibility: () => ({ ok: true, visibility: 'public' }),
  checkScopePermission: () => ({ ok: true }),
  checkPublishQuota: () => ({ ok: true }),
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

  it('rejects a text file that has neither filePath nor text (422)', async () => {
    mocks.fileLean.mockResolvedValue({
      userId: OWNER,
      mimeType: 'text/markdown',
      text: '',
    });

    const res = await run(makeReq());
    expect(res.statusCode).toBe(422);
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
