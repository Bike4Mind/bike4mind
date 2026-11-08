import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFindById, mockFindByEntryIds, mockCreateMany, mockDeleteByReviewer, mockRecordAudit } = vi.hoisted(() => ({
  mockRecordAudit: vi.fn(),
  mockFindById: vi.fn(),
  mockFindByEntryIds: vi.fn(),
  mockCreateMany: vi.fn(),
  mockDeleteByReviewer: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const register =
      (method: string) =>
      (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h[method] = fns[fns.length - 1]), chain);
    const chain = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) middleware(req, res, () => undefined);
        return h[(req as { method?: string }).method ?? 'GET']?.(req, res);
      },
      {
        use: (fn: (req: unknown, res: unknown, next: () => void) => void) => (middlewares.push(fn), chain),
        get: register('GET'),
        post: register('POST'),
        delete: register('DELETE'),
        _config: config,
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  adminAuditLogRepository: {
    findByIds: async (ids: string[]) => (await Promise.all(ids.map(id => mockFindById(id)))).filter(Boolean),
  },
  adminAuditReviewRepository: {
    findByEntryIds: (...a: unknown[]) => mockFindByEntryIds(...a),
    createMany: (...a: unknown[]) => mockCreateMany(...a),
    deleteByReviewer: (...a: unknown[]) => mockDeleteByReviewer(...a),
  },
}));

vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>()),
  recordAdminActionFromRequest: (...a: unknown[]) => mockRecordAudit(...a),
}));

import handler from '../reviews';

const ADMIN = { id: 'admin1', isAdmin: true, name: 'Ada', username: 'ada', email: 'ada@example.com' };
const ID_A = 'a'.repeat(24);
const ID_B = 'b'.repeat(24);
const ID_C = 'c'.repeat(24);
const ID_D = 'd'.repeat(24);
const ID_E = 'e'.repeat(24);

const call = (
  method: 'GET' | 'POST' | 'DELETE',
  init: { query?: Record<string, string>; body?: unknown },
  user: unknown = ADMIN
) => {
  const { req, res } = createMocks({ method, query: init.query, body: init.body as Record<string, unknown> });
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const entry = (id: string, overrides: { severity?: string; userId?: string; target?: unknown } = {}) => ({
  id,
  severity: overrides.severity ?? 'critical',
  actor: { kind: 'user', userId: overrides.userId ?? 'someone-else', name: 'Other' },
  target: overrides.target ?? { kind: 'organization', id: 'org-1' },
});

const configOf = () => (handler as unknown as { _config?: { auth?: unknown; requiredScopes?: string[] } })._config;

beforeEach(() => {
  mockRecordAudit.mockReset().mockResolvedValue(null);
  mockFindById.mockReset().mockImplementation(async (id: string) => entry(id));
  mockFindByEntryIds.mockReset().mockResolvedValue([]);
  mockCreateMany
    .mockReset()
    .mockImplementation(async (reviews: Array<{ auditEntryId: string }>) => reviews.map(review => review.auditEntryId));
  mockDeleteByReviewer.mockReset().mockImplementation(async (ids: string[]) => ids);
});

describe('/api/admin/audit-log/reviews', () => {
  it('refuses API keys: jwtOnly and no requiredScopes', () => {
    expect(configOf()?.auth).toBe('jwtOnly');
    expect(configOf()?.requiredScopes).toBeUndefined();
  });

  describe('GET', () => {
    it('rejects a missing or invalid entryId with 400', async () => {
      await expect(call('GET', { query: {} }).promise).rejects.toMatchObject({ statusCode: 400 });
      await expect(call('GET', { query: { entryId: 'nope' } }).promise).rejects.toMatchObject({ statusCode: 400 });
    });

    it('returns the review, or null when there is none', async () => {
      const review = {
        auditEntryId: ID_A,
        reviewer: { userId: 'u', name: 'U' },
        reviewedAt: '2026-10-01T00:00:00.000Z',
      };
      mockFindByEntryIds.mockResolvedValueOnce([review]);
      const found = call('GET', { query: { entryId: ID_A } });
      await found.promise;
      expect(found.res._getJSONData()).toEqual({ review });

      const missing = call('GET', { query: { entryId: ID_B } });
      await missing.promise;
      expect(missing.res._getJSONData()).toEqual({ review: null });
    });

    it('lets a delegated support:read admin read', async () => {
      const { res, promise } = call(
        'GET',
        { query: { entryId: ID_A } },
        { id: 'u2', isAdmin: false, adminPermissions: ['support:read'] }
      );
      await promise;
      expect(res._getJSONData()).toEqual({ review: null });
    });
  });

  describe('POST', () => {
    it('classifies each id and reviews only the eligible ones', async () => {
      mockFindById.mockImplementation(async (id: string) => {
        if (id === ID_A) return null;
        if (id === ID_B) return entry(id, { severity: 'notice' });
        if (id === ID_C) return entry(id, { userId: 'ADMIN1' });
        return entry(id);
      });
      mockFindByEntryIds.mockResolvedValue([{ auditEntryId: ID_D, reviewer: { userId: 'x', name: 'X' } }]);

      const { res, promise } = call('POST', {
        body: { entryIds: [ID_A, ID_B, ID_C, ID_D, ID_E, ID_E], note: '  looks fine  ' },
      });
      await promise;

      expect(mockCreateMany).toHaveBeenCalledWith([
        { auditEntryId: ID_E, reviewer: { userId: 'admin1', name: 'Ada' }, note: 'looks fine' },
      ]);
      expect(mockRecordAudit).toHaveBeenCalledTimes(1);
      expect(mockRecordAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'audit.reviewed', details: { entryIds: [ID_E], hasNote: true } })
      );
      expect(res._getJSONData()).toEqual({
        reviewed: [ID_E],
        skipped: [
          { id: ID_A, reason: 'not_found' },
          { id: ID_B, reason: 'not_critical' },
          { id: ID_C, reason: 'own_action' },
          { id: ID_D, reason: 'already_reviewed' },
        ],
      });
    });

    it('skips an entry about the reviewer own account as about_you and creates no review', async () => {
      mockFindById.mockImplementation(async (id: string) =>
        id === ID_A
          ? entry(id, { target: { kind: 'user', id: 'ADMIN1' } })
          : entry(id, { target: { kind: 'organization', id: 'admin1' } })
      );

      const { res, promise } = call('POST', { body: { entryIds: [ID_A, ID_B] } });
      await promise;

      expect(mockCreateMany).toHaveBeenCalledWith([
        { auditEntryId: ID_B, reviewer: { userId: 'admin1', name: 'Ada' } },
      ]);
      expect(res._getJSONData()).toEqual({ reviewed: [ID_B], skipped: [{ id: ID_A, reason: 'about_you' }] });
    });

    it('does not create any review when every entry is about the reviewer', async () => {
      mockFindById.mockImplementation(async (id: string) => entry(id, { target: { kind: 'user', id: 'admin1' } }));

      const { res, promise } = call('POST', { body: { entryIds: [ID_A] } });
      await promise;

      expect(mockCreateMany.mock.calls.flatMap(([reviews]) => reviews as unknown[])).toEqual([]);
      expect(res._getJSONData()).toEqual({ reviewed: [], skipped: [{ id: ID_A, reason: 'about_you' }] });
    });

    it('omits an empty note and never uses the email as the reviewer name', async () => {
      await call(
        'POST',
        { body: { entryIds: [ID_A], note: '   ' } },
        { id: 'admin1', isAdmin: true, email: 'ada@example.com' }
      ).promise;

      expect(mockCreateMany).toHaveBeenCalledWith([
        { auditEntryId: ID_A, reviewer: { userId: 'admin1', name: 'Admin' } },
      ]);
    });

    it('reports an id a concurrent review won as already_reviewed', async () => {
      mockCreateMany.mockResolvedValue([ID_A]);

      const { res, promise } = call('POST', { body: { entryIds: [ID_A, ID_B] } });
      await promise;

      expect(res._getJSONData()).toEqual({ reviewed: [ID_A], skipped: [{ id: ID_B, reason: 'already_reviewed' }] });
    });

    it('rejects an invalid body with 400', async () => {
      await expect(call('POST', { body: { entryIds: [] } }).promise).rejects.toMatchObject({ statusCode: 400 });
      await expect(call('POST', { body: { entryIds: ['NOT-AN-ID'] } }).promise).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(mockCreateMany).not.toHaveBeenCalled();
    });

    it('rejects a delegated admin who is not a full admin with 403', async () => {
      await expect(
        call('POST', { body: { entryIds: [ID_A] } }, { id: 'u2', isAdmin: false, adminPermissions: ['support:read'] })
          .promise
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(mockCreateMany).not.toHaveBeenCalled();
    });

    it('rejects an impersonating session with 403', async () => {
      await expect(
        call('POST', { body: { entryIds: [ID_A] } }, { ...ADMIN, impersonatedBy: 'real-admin' }).promise
      ).rejects.toMatchObject({ statusCode: 403, message: 'Stop impersonating to review audit entries.' });
      expect(mockCreateMany).not.toHaveBeenCalled();
    });
  });

  describe('DELETE', () => {
    it('unmarks the caller reviews and reports the rest', async () => {
      mockFindByEntryIds.mockResolvedValue([
        { auditEntryId: ID_A, reviewer: { userId: 'admin1', name: 'Ada' } },
        { auditEntryId: ID_B, reviewer: { userId: 'someone-else', name: 'Other' } },
        { auditEntryId: ID_C, reviewer: { userId: null, name: 'Baseline' }, baseline: true },
      ]);

      const { res, promise } = call('DELETE', { body: { entryIds: [ID_A, ID_B, ID_C, ID_D] } });
      await promise;

      expect(mockDeleteByReviewer).toHaveBeenCalledWith([ID_A], 'admin1');
      expect(mockRecordAudit).toHaveBeenCalledTimes(1);
      expect(mockRecordAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'audit.unreviewed', details: { entryIds: [ID_A] } })
      );
      expect(res._getJSONData()).toEqual({
        unreviewed: [ID_A],
        skipped: [
          { id: ID_B, reason: 'not_reviewer' },
          { id: ID_C, reason: 'not_reviewer' },
          { id: ID_D, reason: 'not_reviewed' },
        ],
      });
    });

    it('writes no audit row when nothing was unreviewed', async () => {
      mockDeleteByReviewer.mockResolvedValue([]);
      await call('DELETE', { body: { entryIds: [ID_A] } }).promise;
      expect(mockRecordAudit).not.toHaveBeenCalled();
    });

    it('rejects a non-full admin and an impersonating session with 403', async () => {
      await expect(
        call('DELETE', { body: { entryIds: [ID_A] } }, { id: 'u2', isAdmin: false, adminPermissions: ['support:read'] })
          .promise
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        call('DELETE', { body: { entryIds: [ID_A] } }, { ...ADMIN, impersonatedBy: 'real-admin' }).promise
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(mockDeleteByReviewer).not.toHaveBeenCalled();
    });
  });
});
