import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';
import { AUDIT_EXPORT_MAX_ROWS } from '@bike4mind/common';

const { mockList, mockRecord } = vi.hoisted(() => ({ mockList: vi.fn(), mockRecord: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
        _config: config,
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@bike4mind/database', () => ({
  adminAuditLogRepository: { list: (...a: unknown[]) => mockList(...a) },
}));
vi.mock('@server/utils/adminAudit', () => ({
  recordAdminActionFromRequest: (...a: unknown[]) => mockRecord(...a),
}));

import handler from '../export';

const call = (query: Record<string, string | string[]> = {}, user: unknown = { id: 'admin1', isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'GET', query });
  if (user) (req as Record<string, unknown>).user = user;
  return { req, res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const scopesOf = () => (handler as unknown as { _config?: { requiredScopes?: string[] } })._config?.requiredScopes;

const OBJECT_ID = 'b'.repeat(24);
const makeEntry = (index: number, overrides: Record<string, unknown> = {}) => ({
  id: String(index).padStart(24, '0'),
  source: 'admin',
  occurredAt: new Date('2026-09-01T10:00:00.000Z'),
  action: 'credits.granted',
  category: 'credits',
  severity: 'info',
  actor: { kind: 'user', scope: 'platform', name: 'Ada Admin', wasAdmin: true, userId: 'u1', email: 'ada@example.com' },
  target: { kind: 'user', id: 'u2', displayName: 'Bob' },
  summary: 'granted credits',
  context: { source: 'admin_ui', ip: '10.0.0.1', requestId: 'req-1' },
  ...overrides,
});

beforeEach(() => {
  mockList.mockReset().mockResolvedValue({ entries: [], nextCursor: null });
  mockRecord.mockReset().mockResolvedValue({ id: OBJECT_ID });
});

describe('GET /api/admin/audit-log/export', () => {
  it('declares requiredScopes [ApiKeyScope.ADMIN]', () => {
    expect(scopesOf()).toEqual([ApiKeyScope.ADMIN]);
  });

  it('rejects a non-admin with 403', async () => {
    const { promise } = call({}, { id: 'u2', isAdmin: false });
    await expect(promise).rejects.toMatchObject({ statusCode: 403 });
  });

  it('writes the header and one row per entry', async () => {
    mockList.mockResolvedValue({
      entries: [
        makeEntry(1),
        makeEntry(2, {
          reason: undefined,
          actor: { kind: 'system', scope: 'platform', name: 'cron', wasAdmin: false },
        }),
      ],
      nextCursor: null,
    });
    const { res, promise } = call();
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(String(res.getHeader('Content-Disposition'))).toMatch(
      /^attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"$/
    );
    expect(res.getHeader('X-Audit-Export-Truncated')).toBe('false');

    const lines = res._getData().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      '"occurredAt","action","category","severity","actorName","actorEmail","actorUserId","impersonatedUserId","targetKind","targetId","targetName","summary","reason","source","ip","requestId","entryId"'
    );
    expect(lines[1]).toBe(
      '"2026-09-01T10:00:00.000Z","credits.granted","credits","info","Ada Admin","ada@example.com","u1","","user","u2","Bob","granted credits","","admin_ui","10.0.0.1","req-1","000000000000000000000001"'
    );
    expect(lines[2]).toContain('"cron","","","",');
  });

  it('caps the export at 50000 and flags truncation', async () => {
    mockList.mockImplementation(async () => ({
      entries: Array.from({ length: 1000 }, (_, index) => makeEntry(index)),
      nextCursor: { occurredAt: new Date('2026-09-01T00:00:00.000Z'), id: OBJECT_ID },
    }));
    const { res, promise } = call();
    await promise;

    expect(mockList).toHaveBeenCalledTimes(AUDIT_EXPORT_MAX_ROWS / 1000);
    expect(res._getData().split('\n')).toHaveLength(AUDIT_EXPORT_MAX_ROWS + 1);
    expect(res.getHeader('X-Audit-Export-Truncated')).toBe('true');
  });

  it('passes the filters and the previous cursor to each page, ignoring limit and cursor params', async () => {
    const nextCursor = { occurredAt: new Date('2026-09-01T00:00:00.000Z'), id: OBJECT_ID };
    mockList
      .mockResolvedValueOnce({ entries: [makeEntry(1)], nextCursor })
      .mockResolvedValueOnce({ entries: [makeEntry(2)], nextCursor: null });
    await call({ category: 'credits', limit: '5', cursor: 'junk' }).promise;

    expect(mockList).toHaveBeenNthCalledWith(1, { category: 'credits' }, { limit: 1000, cursor: undefined });
    expect(mockList).toHaveBeenNthCalledWith(2, { category: 'credits' }, { limit: 1000, cursor: nextCursor });
  });

  it('records audit.exported with rowCount and filters', async () => {
    mockList.mockResolvedValue({ entries: [makeEntry(1), makeEntry(2)], nextCursor: null });
    const { req, promise } = call({ category: 'credits' });
    await promise;

    expect(mockRecord).toHaveBeenCalledWith(req, {
      action: 'audit.exported',
      target: { kind: 'system', id: 'admin-audit-log', displayName: 'Audit Log' },
      summary: 'exported 2 audit entries',
      details: { rowCount: 2, truncated: false, filters: { category: 'credits' } },
    });
  });

  it('still returns the CSV when the audit write fails', async () => {
    mockList.mockResolvedValue({ entries: [makeEntry(1)], nextCursor: null });
    mockRecord.mockResolvedValue(null);
    const { res, promise } = call();
    await promise;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getData().split('\n')).toHaveLength(2);
  });
});
