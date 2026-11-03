import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@server/auth/assertOutboundActionAllowed', () => ({
  outboundActionGate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  assertOutboundActionAllowed: async () => undefined,
}));
import { createHash } from 'node:crypto';
import { PUBLISH_QUOTAS, TooManyRequestsError } from '@bike4mind/common';

vi.mock('@server/utils/untrustedCompletionQuota', () => ({
  admitRequestCompletion: vi.fn().mockResolvedValue({ release: async () => undefined }),
}));

/**
 * Storage quota and the daily publish allowance on the two routes that rewrite a live page in place.
 * The real checkInPlaceRewriteQuota -> checkPublishQuota run against a stubbed usage aggregate, so
 * the net-bytes math is what is under test, not a mock of it.
 */

const m = vi.hoisted(() => ({
  findOneLean: vi.fn(),
  lock: vi.fn(),
  updateOne: vi.fn(),
  aggregate: vi.fn(),
  annotationsLean: vi.fn(),
  updateMany: vi.fn(),
  download: vi.fn(),
  upload: vi.fn(),
  consume: vi.fn(),
  refund: vi.fn(),
  validate: vi.fn(),
  getModel: vi.fn(),
  complete: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, { use: () => chain, post: (...fns: unknown[]) => fns[fns.length - 1] });
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getPublishedArtifactsStorage: () => ({ download: m.download, upload: m.upload }),
}));
vi.mock('@bike4mind/server-utils/utils/publishThumbnails', () => ({
  enqueuePublishThumbnail: () => Promise.resolve(),
}));
vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: {
    findOne: () => ({ lean: m.findOneLean }),
    findOneAndUpdate: m.lock,
    updateOne: m.updateOne,
    aggregate: m.aggregate,
  },
  Annotation: {
    find: () => ({ sort: () => ({ select: () => ({ lean: m.annotationsLean }) }) }),
    updateMany: m.updateMany,
  },
}));
vi.mock('@server/services/publish', async () => {
  const quota = await vi.importActual<typeof import('@server/services/publish/checkPublishQuota')>(
    '@server/services/publish/checkPublishQuota'
  );
  return {
    validateBundle: m.validate,
    buildPublishUrlPath: () => '/p/u/owner1/page',
    invalidatePublishCdn: () => Promise.resolve(),
    toCacheTarget: () => ({}),
    checkInPlaceRewriteQuota: quota.checkInPlaceRewriteQuota,
    consumePublishAction: m.consume,
  };
});
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: {
    getOperationsModel: () => m.getModel(),
  },
}));

import reviseHandler from '../revise';
import restoreHandler from '../restore';

const USER_CAP = PUBLISH_QUOTAS.user.maxTotalBytes;
const ASSET_BYTES = 1000;
const CREATED_AT = new Date('2026-10-20T00:00:00.000Z');
const PREFIX = 'user/owner1/page/';

const page = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;
const CURRENT = page('current version');
const BIGGER = page(`a longer version ${'x'.repeat(400)}`);
const SMALLER = page('short');

/** The live page: index.html plus one untouched asset. */
const artifact = (indexBytes = CURRENT.length) => ({
  publicId: 'pub1',
  tier: 'user',
  scopeId: 'owner1',
  slug: 'page',
  title: 'Page',
  visibility: 'private',
  ownerId: 'owner1',
  storageKeyPrefix: PREFIX,
  sha256Index: 'sha-current',
  size: { totalBytes: indexBytes + ASSET_BYTES, fileCount: 2 },
  manifest: [
    { path: 'index.html', size: indexBytes, mimeType: 'text/html', sha256: 'sha-current' },
    { path: 'logo.png', size: ASSET_BYTES, mimeType: 'image/png', sha256: 'sha-logo' },
  ],
  publishedAt: new Date('2026-10-01T00:00:00.000Z'),
  source: { kind: 'bundle' },
  previousVersionMeta: { sha256Index: 'sha-prev' },
  versions: [{ sha256Index: 'sha-prev' }, { sha256Index: 'sha-current' }],
});

type Res = { statusCode: number; body: unknown; status: (c: number) => Res; json: (o: unknown) => Res };
const makeRes = (): Res => {
  const res = { statusCode: 0, body: undefined as unknown } as Res;
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (o: unknown) => ((res.body = o), res);
  return res;
};
const run = async (handler: unknown) => {
  const res = makeRes();
  const req = {
    query: { publicId: 'pub1' },
    body: {},
    user: { id: 'owner1', isAdmin: false, createdAt: CREATED_AT },
    logger: { info: vi.fn(), warn: vi.fn() },
  };
  await (handler as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
};

/** The owner's OTHER pages (this one is excluded from usage) leave exactly `room` bytes free. */
const otherPagesLeave = (room: number, currentTotal = CURRENT.length + ASSET_BYTES) =>
  m.aggregate.mockResolvedValue([{ totalBytes: USER_CAP - currentTotal - room }]);

const indexWrites = () => m.upload.mock.calls.filter(c => c[1] === `${PREFIX}index.html`);
const recordWrites = () =>
  m.updateOne.mock.calls.filter(c => (c[1] as { $set?: { manifest?: unknown } }).$set?.manifest);
const lockReleased = () =>
  m.updateOne.mock.calls.some(c => 'revisingAt' in (c[0] as object) && (c[1] as { $set: object }).$set);

beforeEach(() => {
  vi.clearAllMocks();
  m.findOneLean.mockResolvedValue(artifact());
  m.lock.mockResolvedValue({ publicId: 'pub1' });
  m.updateOne.mockResolvedValue({});
  m.updateMany.mockResolvedValue({});
  m.aggregate.mockResolvedValue([{ totalBytes: 0 }]);
  m.annotationsLean.mockResolvedValue([{ body: 'Make it longer', authorDisplayName: 'Reviewer' }]);
  m.upload.mockResolvedValue(undefined);
  m.refund.mockResolvedValue(undefined);
  m.consume.mockResolvedValue({ refund: m.refund });
  m.validate.mockReturnValue({ valid: true, violations: [] });
  m.getModel.mockResolvedValue({
    modelId: 'm1',
    llm: { complete: m.complete },
    modelInfo: { name: 'Model', backend: 'test' },
  });
  previousVersionIs(BIGGER);
  modelReturns(BIGGER);
});

/** Make the model answer with `html`. */
const modelReturns = (html: string) =>
  m.complete.mockImplementation(async (...args: unknown[]) => {
    await (args[3] as (chunk: string[]) => Promise<void>)([html]);
  });
/** Make the archived previous version hold `html`. */
const previousVersionIs = (html: string) =>
  m.download.mockImplementation((key: string) =>
    Promise.resolve(Buffer.from(key.endsWith('versions/sha-prev.html') ? html : CURRENT))
  );

describe.each([
  { name: 'revise', handler: reviseHandler, newIndexIs: modelReturns, countsBeforeQuota: true },
  { name: 'restore', handler: restoreHandler, newIndexIs: previousVersionIs, countsBeforeQuota: false },
])('$name - storage quota on the net change', ({ handler, newIndexIs, countsBeforeQuota }) => {
  const growth = BIGGER.length - CURRENT.length;

  it('passes growth that fits, charging the page its new total in place of its old one', async () => {
    newIndexIs(BIGGER);
    otherPagesLeave(growth);

    const res = await run(handler);

    expect(res.statusCode).toBe(200);
    expect(indexWrites()).toHaveLength(1);
    const [pipeline] = m.aggregate.mock.calls[0] as [Array<{ $match?: Record<string, unknown> }>];
    // Usage is the owner's other pages: this one is excluded, and its new total is added back.
    expect(pipeline[0].$match).toMatchObject({
      ownerId: 'owner1',
      deletedAt: null,
      $nor: [{ tier: 'user', scopeId: 'owner1', slug: 'page' }],
    });
    const written = recordWrites()[0][1] as { $set: { size: { totalBytes: number } } };
    expect(written.$set.size.totalBytes).toBe(BIGGER.length + ASSET_BYTES);
  });

  it('refuses growth one byte past the cap with a 413 and writes nothing', async () => {
    newIndexIs(BIGGER);
    otherPagesLeave(growth - 1);

    const res = await run(handler);

    expect(res.statusCode).toBe(413);
    expect(res.body).toMatchObject({
      code: 'quota_bytes_exceeded',
      details: { scope: 'user', limit: USER_CAP, attempted: USER_CAP + 1 },
    });
    expect(indexWrites()).toHaveLength(0);
    expect(recordWrites()).toHaveLength(0);
    // revise counts before the model call, and an attempt that reached the model keeps its count
    // even when the quota then refuses it; restore checks the quota first and never counts.
    expect(m.consume).toHaveBeenCalledTimes(countsBeforeQuota ? 1 : 0);
    expect(m.refund).not.toHaveBeenCalled();
    expect(lockReleased()).toBe(true);
  });

  it('allows a rewrite that shrinks the page without reading usage, even for an owner over the cap', async () => {
    newIndexIs(SMALLER);
    m.aggregate.mockResolvedValue([{ totalBytes: USER_CAP * 2 }]);

    const res = await run(handler);

    expect(res.statusCode).toBe(200);
    expect(m.aggregate).not.toHaveBeenCalled();
  });
});

describe('revise - daily publish allowance', () => {
  it('counts one action, before the model runs', async () => {
    const res = await run(reviseHandler);

    expect(res.statusCode).toBe(200);
    expect(m.consume).toHaveBeenCalledTimes(1);
    expect(m.consume).toHaveBeenCalledWith(expect.objectContaining({ id: 'owner1', createdAt: CREATED_AT }));
    expect(m.consume.mock.invocationCallOrder[0]).toBeLessThan(m.complete.mock.invocationCallOrder[0]);
  });

  it('refuses before the model runs once the allowance is used up, and frees the revise lock', async () => {
    const limited = new TooManyRequestsError('limited', { code: 'publish_rate_limited', retryAfter: 60 });
    m.consume.mockRejectedValue(limited);

    await expect(run(reviseHandler)).rejects.toBe(limited);
    expect(m.complete).not.toHaveBeenCalled();
    expect(m.upload).not.toHaveBeenCalled();
    expect(lockReleased()).toBe(true);
  });

  it('does not count a revise with no feedback to apply', async () => {
    m.annotationsLean.mockResolvedValue([]);
    const res = await run(reviseHandler);

    expect(res.statusCode).toBe(400);
    expect(m.consume).not.toHaveBeenCalled();
  });

  it('keeps the action once the revised page is written', async () => {
    const res = await run(reviseHandler);

    expect(res.statusCode).toBe(200);
    expect(m.refund).not.toHaveBeenCalled();
  });

  it('hands the action back when the revise ends before the model is called', async () => {
    const noModel = new Error('no operations model configured');
    m.getModel.mockRejectedValue(noModel);

    await expect(run(reviseHandler)).rejects.toBe(noModel);
    expect(m.consume).toHaveBeenCalledTimes(1);
    expect(m.complete).not.toHaveBeenCalled();
    expect(m.refund).toHaveBeenCalledTimes(1);
    expect(lockReleased()).toBe(true);
  });

  it('keeps the action when the model call fails', async () => {
    const modelDown = new Error('model unavailable');
    m.complete.mockRejectedValue(modelDown);

    await expect(run(reviseHandler)).rejects.toBe(modelDown);
    expect(m.consume).toHaveBeenCalledTimes(1);
    expect(m.refund).not.toHaveBeenCalled();
    expect(indexWrites()).toHaveLength(0);
    expect(lockReleased()).toBe(true);
  });

  it.each([
    { kind: 'not a complete document', output: 'not html at all' },
    { kind: 'truncated', output: '<html></html>' },
  ])('keeps the action when the model output is $kind', async ({ output }) => {
    modelReturns(output);

    const res = await run(reviseHandler);

    expect(res.statusCode).toBe(502);
    expect(m.refund).not.toHaveBeenCalled();
    expect(indexWrites()).toHaveLength(0);
  });

  it('keeps the action when the revised page fails validation', async () => {
    m.validate.mockReturnValue({ valid: false, violations: [{ rule: 'external-script' }] });

    const res = await run(reviseHandler);

    expect(res.statusCode).toBe(422);
    expect(m.refund).not.toHaveBeenCalled();
    expect(indexWrites()).toHaveLength(0);
  });

  it('keeps the action when the revised page cannot be stored', async () => {
    const storageDown = new Error('storage unavailable');
    m.upload.mockImplementation((_buf: unknown, key: string) =>
      key === `${PREFIX}index.html` ? Promise.reject(storageDown) : Promise.resolve()
    );

    await expect(run(reviseHandler)).rejects.toBe(storageDown);
    expect(m.refund).not.toHaveBeenCalled();
    expect(recordWrites()).toHaveLength(0);
  });

  it('keeps the action when the page was written but its record update fails', async () => {
    const dbDown = new Error('database unavailable');
    m.updateOne.mockImplementation((filter: object) =>
      'revisingAt' in filter ? Promise.resolve({}) : Promise.reject(dbDown)
    );

    await expect(run(reviseHandler)).rejects.toBe(dbDown);
    expect(indexWrites()).toHaveLength(1);
    expect(m.refund).not.toHaveBeenCalled();
  });

  it('refunds nothing when the allowance itself refused the revise', async () => {
    m.consume.mockRejectedValue(new TooManyRequestsError('limited', { code: 'publish_rate_limited' }));

    await expect(run(reviseHandler)).rejects.toBeInstanceOf(TooManyRequestsError);
    expect(m.refund).not.toHaveBeenCalled();
  });
});

describe('restore - daily publish allowance', () => {
  it('counts one action', async () => {
    const res = await run(restoreHandler);

    expect(res.statusCode).toBe(200);
    expect(m.consume).toHaveBeenCalledTimes(1);
    expect(m.consume).toHaveBeenCalledWith(expect.objectContaining({ id: 'owner1', createdAt: CREATED_AT }));
  });

  it('writes nothing once the allowance is used up, and frees the lock', async () => {
    const limited = new TooManyRequestsError('limited', { code: 'publish_rate_limited', retryAfter: 60 });
    m.consume.mockRejectedValue(limited);

    await expect(run(restoreHandler)).rejects.toBe(limited);
    expect(m.upload).not.toHaveBeenCalled();
    expect(recordWrites()).toHaveLength(0);
    expect(lockReleased()).toBe(true);
  });

  it('does not count a restore with nothing to restore', async () => {
    m.findOneLean.mockResolvedValue({ ...artifact(), previousVersionMeta: undefined });
    const res = await run(restoreHandler);

    expect(res.statusCode).toBe(400);
    expect(m.consume).not.toHaveBeenCalled();
  });

  it('keeps the action once the restored page is written', async () => {
    const res = await run(restoreHandler);

    expect(res.statusCode).toBe(200);
    expect(m.refund).not.toHaveBeenCalled();
  });

  it('hands the action back when the restored page cannot be stored', async () => {
    const storageDown = new Error('storage unavailable');
    m.upload.mockImplementation((_buf: unknown, key: string) =>
      key === `${PREFIX}index.html` ? Promise.reject(storageDown) : Promise.resolve()
    );

    await expect(run(restoreHandler)).rejects.toBe(storageDown);
    expect(m.consume).toHaveBeenCalledTimes(1);
    expect(m.refund).toHaveBeenCalledTimes(1);
    expect(recordWrites()).toHaveLength(0);
    expect(lockReleased()).toBe(true);
  });
});

// Each revise/restore archives the replaced index.html under versions/, and those archived bytes
// count toward the storage quota (see checkInPlaceRewriteQuota).
describe('archived versions', () => {
  const sha = (html: string) => createHash('sha256').update(html).digest('hex');
  const pushedVersions = () =>
    (recordWrites()[0][1] as { $push: { versions: { $each: Array<Record<string, unknown>> } } }).$push.versions.$each;
  const archiveOf = (versionSha: string) =>
    m.upload.mock.calls.find(c => c[1] === `${PREFIX}versions/${versionSha}.html`)?.[0] as Buffer | undefined;
  /** Storage holds CURRENT at index.html and `html` archived under `versionSha`. */
  const archivedVersionIs = (versionSha: string, html: string) =>
    m.download.mockImplementation((key: string) =>
      Promise.resolve(Buffer.from(key.endsWith(`versions/${versionSha}.html`) ? html : CURRENT))
    );

  it('revise records indexBytes on the version it archives and on the new one', async () => {
    m.findOneLean.mockResolvedValue({ ...artifact(), versions: [{ sha256Index: 'sha-prev', indexBytes: 50 }] });

    const res = await run(reviseHandler);

    expect(res.statusCode).toBe(200);
    expect(pushedVersions()).toEqual([
      expect.objectContaining({ sha256Index: 'sha-current', indexBytes: CURRENT.length }),
      expect.objectContaining({ sha256Index: sha(BIGGER), indexBytes: BIGGER.length }),
    ]);
    expect(archiveOf('sha-current')?.length).toBe(CURRENT.length);
  });

  it('revise archives the stored index.html bytes as they are, and records their length', async () => {
    // Not valid UTF-8: decoding and re-encoding would swap the byte for a 3-byte replacement character.
    const stored = Buffer.concat([Buffer.from(CURRENT), Buffer.from([0xe9])]);
    m.download.mockResolvedValue(stored);
    m.findOneLean.mockResolvedValue({ ...artifact(stored.length), versions: [] });

    const res = await run(reviseHandler);

    expect(res.statusCode).toBe(200);
    expect(archiveOf('sha-current')?.equals(stored)).toBe(true);
    expect(pushedVersions()[0]).toEqual(
      expect.objectContaining({ sha256Index: 'sha-current', indexBytes: stored.length })
    );
  });

  it('restore records indexBytes on the version it archives and on a restored copy history lacks', async () => {
    m.findOneLean.mockResolvedValue({ ...artifact(), versions: [{ sha256Index: 'sha-prev', indexBytes: 50 }] });

    const res = await run(restoreHandler);

    expect(res.statusCode).toBe(200);
    expect(pushedVersions()).toEqual([
      expect.objectContaining({ sha256Index: 'sha-current', indexBytes: CURRENT.length }),
      expect.objectContaining({ sha256Index: sha(BIGGER), indexBytes: BIGGER.length }),
    ]);
    expect(archiveOf('sha-current')?.length).toBe(CURRENT.length);
  });

  it('revise refuses a revision that shrinks the bundle once archiving the current version passes the cap', async () => {
    const versions = [
      { sha256Index: 'sha-prev', indexBytes: 50 },
      { sha256Index: 'sha-current', indexBytes: CURRENT.length },
    ];
    m.findOneLean.mockResolvedValue({ ...artifact(), versions });
    modelReturns(SMALLER);
    // The page's footprint grows by the revised index.html: the bundle shrinks, the archive gains CURRENT.
    const footprint = CURRENT.length + ASSET_BYTES + 50;

    otherPagesLeave(SMALLER.length, footprint);
    expect((await run(reviseHandler)).statusCode).toBe(200);

    vi.clearAllMocks();
    otherPagesLeave(SMALLER.length - 1, footprint);
    const res = await run(reviseHandler);

    expect(res.statusCode).toBe(413);
    expect(res.body).toMatchObject({ code: 'quota_bytes_exceeded', details: { attempted: USER_CAP + 1 } });
    expect(indexWrites()).toHaveLength(0);
    expect(recordWrites()).toHaveLength(0);
  });

  it('revise allows a revision that leaves the page unchanged, even for an owner over the cap', async () => {
    const page = { ...artifact(), sha256Index: sha(CURRENT) };
    m.findOneLean.mockResolvedValue({ ...page, versions: [{ sha256Index: sha(CURRENT), indexBytes: CURRENT.length }] });
    modelReturns(CURRENT);
    m.aggregate.mockResolvedValue([{ totalBytes: USER_CAP * 2 }]);

    const res = await run(reviseHandler);

    expect(res.statusCode).toBe(200);
    expect(m.aggregate).not.toHaveBeenCalled();
    expect(pushedVersions()).toEqual([]);
  });

  it('restore refuses when the version it archives passes the cap and the restored one was never counted', async () => {
    // The restored version predates indexBytes, so its archived copy counted 0 before and frees nothing.
    m.findOneLean.mockResolvedValue({
      ...artifact(),
      previousVersionMeta: { sha256Index: sha(SMALLER) },
      versions: [{ sha256Index: sha(SMALLER) }, { sha256Index: 'sha-current', indexBytes: CURRENT.length }],
    });
    archivedVersionIs(sha(SMALLER), SMALLER);
    otherPagesLeave(SMALLER.length - 1);

    const res = await run(restoreHandler);

    expect(res.statusCode).toBe(413);
    expect(res.body).toMatchObject({ code: 'quota_bytes_exceeded', details: { attempted: USER_CAP + 1 } });
    expect(indexWrites()).toHaveLength(0);
    expect(recordWrites()).toHaveLength(0);
    expect(m.consume).not.toHaveBeenCalled();
  });

  it('restore that swaps which archived version is current adds nothing, even for an owner over the cap', async () => {
    m.findOneLean.mockResolvedValue({
      ...artifact(),
      previousVersionMeta: { sha256Index: sha(SMALLER) },
      versions: [
        { sha256Index: sha(SMALLER), indexBytes: SMALLER.length },
        { sha256Index: 'sha-current', indexBytes: CURRENT.length },
      ],
    });
    archivedVersionIs(sha(SMALLER), SMALLER);
    m.aggregate.mockResolvedValue([{ totalBytes: USER_CAP * 2 }]);

    const res = await run(restoreHandler);

    expect(res.statusCode).toBe(200);
    expect(m.aggregate).not.toHaveBeenCalled();
    expect(pushedVersions()).toEqual([]);
  });
});
