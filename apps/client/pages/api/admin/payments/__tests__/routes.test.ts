import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';
import type { AdminPaymentRow } from '@bike4mind/server-utils/app/utils/adminPayments';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const middlewares: ((req: unknown, res: unknown, next: () => void) => unknown)[] = [];
    const chain = Object.assign(
      async (req: { method?: string }, res: unknown) => {
        for (const middleware of middlewares) await middleware(req, res, () => undefined);
        return handlers[req.method ?? 'GET']?.(req, res);
      },
      {
        use: (middleware: (typeof middlewares)[number]) => (middlewares.push(middleware), chain),
        get: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.GET = fn), chain),
        _config: config,
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));

const mockList = vi.hoisted(() => vi.fn());
const mockSummary = vi.hoisted(() => vi.fn());
const mockExport = vi.hoisted(() => vi.fn());
vi.mock('@server/admin/payments/adminPayments', () => ({
  listAdminPayments: mockList,
  adminPaymentsSummary: mockSummary,
  exportAdminPayments: mockExport,
}));
vi.mock('@server/admin/payments/paymentsQuery', () => ({ PAYMENTS_OWNER_SEARCH_LIMIT: 500 }));

import listHandler from '../index';
import summaryHandler from '../summary';
import exportHandler, { PAYMENTS_CSV_HEADER, toPaymentCsvLine } from '../export';

const ADMIN = { id: 'a'.repeat(24), isAdmin: true };
type Handler = (req: unknown, res: unknown) => Promise<unknown>;

async function call(handler: unknown, query: Record<string, string>, user: Record<string, unknown> = ADMIN) {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { user, logger: { error: vi.fn() } });
  await (handler as Handler)(req, res);
  return res;
}

const ROW: AdminPaymentRow = {
  id: 'b'.repeat(24),
  kind: 'credit_purchase',
  status: 'partially_refunded',
  occurredAt: '2026-11-05T10:00:00.000Z',
  ownerType: 'user',
  ownerId: 'c'.repeat(24),
  owner: { kind: 'user', id: 'c'.repeat(24), name: '=Formula Name', email: 'buyer@example.test' },
  amount: 1999,
  currency: 'usd',
  refundedAmount: 500,
  credits: 2000,
  paymentIntentId: 'pi_fixture',
  invoiceId: null,
  subscriptionId: null,
};

describe('admin payments routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockList.mockResolvedValue({ payments: [], total: 0, page: 1, totalPages: 1, searchTruncated: false });
    mockSummary.mockResolvedValue({});
    mockExport.mockResolvedValue({ rows: [ROW], searchTruncated: false });
  });

  it.each([
    ['list', listHandler],
    ['summary', summaryHandler],
    ['export', exportHandler],
  ])('%s requires JWT auth with admin scope and refuses a non-admin before reading', async (_name, handler) => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
      allowedMethods: ['GET'],
    });
    await expect(call(handler, {}, { ...ADMIN, isAdmin: false })).rejects.toThrow(/missing permission/i);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockSummary).not.toHaveBeenCalled();
    expect(mockExport).not.toHaveBeenCalled();
  });

  it('parses the list filters and pages, with no-store caching', async () => {
    const res = await call(listHandler, {
      from: '2026-11-01',
      to: '2026-11-10',
      kind: 'credit_purchase',
      status: '',
      currency: 'USD',
      minAmount: '500',
      page: '2',
      limit: '50',
    });
    expect(res.statusCode).toBe(200);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '2026-11-01',
        kind: 'credit_purchase',
        currency: 'usd',
        minAmount: 500,
        page: 2,
        limit: 50,
      })
    );
    expect(mockList.mock.calls[0][0].status).toBeUndefined();
  });

  it.each([
    [{ from: '2026-11-10', to: '2026-11-01' }],
    [{ from: '2024-01-01', to: '2026-11-01' }],
    [{ minAmount: '900', maxAmount: '100' }],
    [{ status: 'charged_back' }],
    [{ limit: '30' }],
  ])('rejects %o with 400 before reading', async query => {
    const res = await call(listHandler, query);
    expect(res.statusCode).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('exports CSV in major units with the range and definitions, defusing formula cells', async () => {
    const res = await call(exportHandler, { from: '2026-11-01', to: '2026-11-10' });
    const lines = (res._getData() as string).trim().split('\n');

    expect(res.getHeader('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.getHeader('Content-Disposition')).toBe('attachment; filename="payments-2026-11-01-to-2026-11-10.csv"');
    expect(lines[0]).toContain('"Amount"');
    expect(lines[1]).toBe(toPaymentCsvLine(ROW));
    expect(lines[1]).toContain(',19.99,5.00,"USD",2000,');
    expect(lines[1]).not.toContain(',"=Formula Name"');
    expect(lines[2]).toBe('# Range: 2026-11-01 to 2026-11-10 (UTC, inclusive)');
    expect(lines.slice(3).every(line => line.startsWith('# '))).toBe(true);
    expect(lines[0].split(',')).toHaveLength(PAYMENTS_CSV_HEADER.length);
    expect(res.getHeader('X-Export-Notes')).toBeUndefined();
  });

  it('marks a truncated export', async () => {
    mockExport.mockResolvedValue({ rows: Array.from({ length: 10_001 }, () => ROW), searchTruncated: true });
    const res = await call(exportHandler, {});
    const body = res._getData() as string;
    expect(body).toContain('# Truncated at 10,000 rows');
    expect(body).toContain('# Search matched more than 500 owners');
    expect(res.getHeader('X-Export-Notes')).toBe('truncated,search_truncated');
    expect(
      body
        .trim()
        .split('\n')
        .filter(line => !line.startsWith('#'))
    ).toHaveLength(10_001);
  });
});
