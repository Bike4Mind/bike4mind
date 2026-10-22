import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFindOneAndUpdate, mockReportUpdateMany } = vi.hoisted(() => ({
  mockFindOneAndUpdate: vi.fn(),
  mockReportUpdateMany: vi.fn(),
}));
const audit = vi.hoisted(() => ({ record: vi.fn(), inTransaction: [] as boolean[], txActive: false }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: audit.record }));

// baseApi mock: callable chain routed by req.method; .use() no-op; last fn per verb is the handler.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.POST = fns[fns.length - 1]), chain),
        delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.DELETE = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

// ForbiddenError: a throwable the handler propagates; we assert it's thrown (the real
// baseApi error middleware maps it to 403, out of scope for a unit test).
vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: {
    findOneAndUpdate: (...a: unknown[]) => mockFindOneAndUpdate(...a),
  },
  PublishedArtifactReport: {
    updateMany: (...a: unknown[]) => Promise.resolve(mockReportUpdateMany(...a)),
  },
  withTransaction: async (fn: () => Promise<unknown>) => {
    audit.txActive = true;
    try {
      return await fn();
    } finally {
      audit.txActive = false;
    }
  },
}));

// Stub the publish service so this test stays focused on takedown logic (the real
// module pulls in AWS/SST). CDN invalidation is covered by invalidatePublishCdn.test.ts.
const invalidateMock = vi.hoisted(() => vi.fn());
vi.mock('@server/services/publish', () => ({
  invalidatePublishCdn: invalidateMock,
  toCacheTarget: (a: unknown) => a,
}));

const thumbnails = vi.hoisted(() => ({
  deletePublishThumbnail: vi.fn(),
  deletePublishThumbnails: vi.fn(),
  enqueuePublishThumbnail: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/utils/publishThumbnails', () => thumbnails);

import handler from '../takedown';

type RunOpts = { method: 'POST' | 'DELETE'; user?: unknown; id?: string; body?: unknown };
const run = ({ method, user, id = 'pub1', body = {} }: RunOpts) => {
  const { req, res } = createMocks({ method, query: { id }, body: body as Record<string, unknown> });
  (req as Record<string, unknown>).logger = { info: vi.fn(), warn: vi.fn() };
  if (user) (req as Record<string, unknown>).user = user;
  return { req, res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

/** The artifact snapshot returned by either atomic lifecycle write. */
function updatedDoc(over: Record<string, unknown> = {}) {
  return {
    publicId: 'pub1',
    tier: 'user',
    scopeId: 'u1',
    ownerId: 'u1',
    slug: 'r-pub1',
    title: 'Report',
    source: { kind: 'reply' },
    ...over,
  };
}

const ADMIN = { id: 'admin1', isAdmin: true };

beforeEach(() => {
  mockFindOneAndUpdate.mockReset();
  mockReportUpdateMany.mockReset().mockResolvedValue({});
  invalidateMock.mockReset();
  thumbnails.deletePublishThumbnail.mockReset().mockResolvedValue(undefined);
  thumbnails.deletePublishThumbnails.mockReset().mockResolvedValue(0);
  thumbnails.enqueuePublishThumbnail.mockReset().mockResolvedValue(true);
  audit.record.mockReset().mockImplementation(async () => {
    audit.inTransaction.push(audit.txActive);
    return null;
  });
  audit.inTransaction = [];
});

describe('takedown and restore - owner-only thumbnails', () => {
  const SHA = 'e'.repeat(64);

  it('atomically detaches and deletes only the old thumbnail, preserving a concurrent restore render', async () => {
    const key = `publish-thumbnails/pub1/${SHA}.webp`;
    mockFindOneAndUpdate.mockResolvedValue(updatedDoc({ source: { kind: 'bundle' }, thumbnail: { key } }));
    const { res, promise } = run({ method: 'POST', user: ADMIN });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockFindOneAndUpdate.mock.calls[0][1].$unset).toEqual({ thumbnail: 1 });
    expect(mockFindOneAndUpdate.mock.calls[0][2]).toEqual({ new: false });
    expect(thumbnails.deletePublishThumbnail).toHaveBeenCalledWith('pub1', key, expect.anything());
    expect(thumbnails.deletePublishThumbnails).not.toHaveBeenCalled();
  });

  it('leaves a restored render intact when restore finishes before takedown cleanup', async () => {
    const oldKey = `publish-thumbnails/pub1/${SHA}.webp`;
    const restoredKey = `publish-thumbnails/pub1/${SHA}-00000000-0000-4000-8000-000000000001.webp`;
    const objects = new Set([oldKey]);
    let finishReports: (() => void) | undefined;
    const reportsPending = new Promise<void>(resolve => {
      finishReports = resolve;
    });
    mockReportUpdateMany.mockReturnValue(reportsPending);
    mockFindOneAndUpdate
      .mockResolvedValueOnce(updatedDoc({ source: { kind: 'bundle' }, thumbnail: { key: oldKey } }))
      .mockResolvedValueOnce(updatedDoc({ source: { kind: 'bundle' }, sha256Index: SHA }));
    thumbnails.deletePublishThumbnail.mockImplementation(async (_publicId: string, key: string) => {
      objects.delete(key);
    });
    thumbnails.enqueuePublishThumbnail.mockImplementation(async () => {
      objects.add(restoredKey);
      return true;
    });

    const takedown = run({ method: 'POST', user: ADMIN });
    await vi.waitFor(() => expect(mockReportUpdateMany).toHaveBeenCalled());
    const restore = run({ method: 'DELETE', user: ADMIN });
    await restore.promise;
    finishReports?.();
    await takedown.promise;

    expect(objects).toEqual(new Set([restoredKey]));
    expect(thumbnails.deletePublishThumbnails).not.toHaveBeenCalled();
  });

  it('deletes nothing when there was no page to take down', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    const { promise } = run({ method: 'POST', user: ADMIN });
    await promise;
    expect(thumbnails.deletePublishThumbnail).not.toHaveBeenCalled();
    expect(thumbnails.deletePublishThumbnails).not.toHaveBeenCalled();
  });

  it('queues a fresh render of the restored version for a bundle', async () => {
    mockFindOneAndUpdate.mockResolvedValue(updatedDoc({ source: { kind: 'bundle' }, sha256Index: SHA }));
    const { res, promise } = run({ method: 'DELETE', user: ADMIN });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(thumbnails.enqueuePublishThumbnail).toHaveBeenCalledWith(
      { publicId: 'pub1', versionId: SHA },
      expect.anything()
    );
  });

  it('queues nothing on restoring a reply page, which is never rendered', async () => {
    mockFindOneAndUpdate.mockResolvedValue(updatedDoc({ sha256Index: SHA }));
    const { promise } = run({ method: 'DELETE', user: ADMIN });
    await promise;
    expect(thumbnails.enqueuePublishThumbnail).not.toHaveBeenCalled();
  });

describe('POST /api/admin/published-artifacts/:id/takedown', () => {
  it('rejects non-admins', async () => {
    const { promise } = run({ method: 'POST', user: { id: 'u1', isAdmin: false } });
    await expect(promise).rejects.toThrow();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('takes a page down atomically, resolves reports, and purges the CDN', async () => {
    mockFindOneAndUpdate.mockResolvedValue(updatedDoc());
    const { res, promise } = run({ method: 'POST', user: ADMIN, body: { reason: 'phishing host' } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    // Atomic update on the live row, not load-then-save.
    const [filter, update] = mockFindOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ publicId: 'pub1', deletedAt: null });
    expect(update.$set).toMatchObject({
      moderationStatus: 'taken_down',
      takedownReason: 'phishing host',
      deletedBy: 'admin1',
    });
    expect(update.$set.deletedAt).toBeInstanceOf(Date);
    expect(mockReportUpdateMany).toHaveBeenCalledWith(
      { publicId: 'pub1', status: 'open' },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'actioned', resolvedBy: 'admin1' }) })
    );
    expect(invalidateMock).toHaveBeenCalledWith(expect.objectContaining({ publicId: 'pub1' }), expect.anything());
  });

  it('404s when the page is missing or already taken down', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    const { res, promise } = run({ method: 'POST', user: ADMIN });
    await promise;
    expect(res._getStatusCode()).toBe(404);
    expect(invalidateMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/admin/published-artifacts/:id/takedown — restore', () => {
  it('rejects non-admins', async () => {
    const { promise } = run({ method: 'DELETE', user: { id: 'u1', isAdmin: false } });
    await expect(promise).rejects.toThrow();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('restores a taken-down page back to active and purges the cached 404', async () => {
    mockFindOneAndUpdate.mockResolvedValue(updatedDoc());
    const { res, promise } = run({ method: 'DELETE', user: ADMIN });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    const [filter, update] = mockFindOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ publicId: 'pub1', moderationStatus: 'taken_down' });
    expect(update.$set).toMatchObject({ moderationStatus: 'active', takedownReason: null, deletedAt: null });
    expect(invalidateMock).toHaveBeenCalledWith(expect.objectContaining({ publicId: 'pub1' }), expect.anything());
  });

  it('404s when there is no taken-down page with that id', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    const { res, promise } = run({ method: 'DELETE', user: ADMIN });
    await promise;
    expect(res._getStatusCode()).toBe(404);
  });

  it('409s when restore collides with a slug re-published while down (E11000)', async () => {
    mockFindOneAndUpdate.mockRejectedValue(Object.assign(new Error('dup key'), { code: 11000 }));
    const { res, promise } = run({ method: 'DELETE', user: ADMIN });
    await promise;
    expect(res._getStatusCode()).toBe(409);
    expect(invalidateMock).not.toHaveBeenCalled();
  });
});

describe('takedown admin audit', () => {
  it('records moderation.published_artifact.taken_down inside the takedown transaction', async () => {
    mockFindOneAndUpdate.mockResolvedValue(updatedDoc());
    const { req, res, promise } = run({ method: 'POST', user: ADMIN, body: { reason: 'phishing host' } });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][0]).toBe(req);
    expect(audit.record.mock.calls[0][1]).toMatchObject({
      action: 'moderation.published_artifact.taken_down',
      target: { kind: 'user', id: 'u1' },
      details: { publicId: 'pub1', slug: 'r-pub1', title: 'Report' },
      reason: 'phishing host',
    });
    expect(audit.inTransaction).toEqual([true]);
    expect(mockReportUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(audit.record.mock.invocationCallOrder[0]);
  });

  it('fails the takedown and skips the CDN purge when the audit write rejects', async () => {
    mockFindOneAndUpdate.mockResolvedValue(updatedDoc());
    audit.record.mockRejectedValue(new Error('audit down'));
    const { res, promise } = run({ method: 'POST', user: ADMIN });

    await expect(promise).rejects.toThrow('audit down');
    expect(res._isEndCalled()).toBe(false);
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it('records nothing when there is no live page to take down', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    const { promise } = run({ method: 'POST', user: ADMIN });
    await promise;

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('records moderation.published_artifact.takedown_reverted inside the restore transaction', async () => {
    mockFindOneAndUpdate.mockResolvedValue(updatedDoc());
    const { res, promise } = run({ method: 'DELETE', user: ADMIN });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][1]).toMatchObject({
      action: 'moderation.published_artifact.takedown_reverted',
      target: { kind: 'user', id: 'u1' },
      details: { publicId: 'pub1' },
    });
    expect(audit.inTransaction).toEqual([true]);
  });

  it('fails the restore and skips the CDN purge when the audit write rejects', async () => {
    mockFindOneAndUpdate.mockResolvedValue(updatedDoc());
    audit.record.mockRejectedValue(new Error('audit down'));
    const { res, promise } = run({ method: 'DELETE', user: ADMIN });

    await expect(promise).rejects.toThrow('audit down');
    expect(res._isEndCalled()).toBe(false);
    expect(invalidateMock).not.toHaveBeenCalled();
  });
});
