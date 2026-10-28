import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => handlers[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.GET = fn), chain),
      _config: config,
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => undefined }));

const mockPage = vi.fn();
const mockMatch = vi.fn();
vi.mock('@server/admin/subscriptionsList/listAdminSubscriptions', () => ({
  adminSubscriptionsExportPage: (...args: unknown[]) => mockPage(...args),
  adminSubscriptionsMatch: (...args: unknown[]) => mockMatch(...args),
  OWNER_SEARCH_LIMIT: 500,
}));
vi.mock('@client/app/utils/adminSubscriptionsFilter', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/utils/adminSubscriptionsFilter')>()),
  ADMIN_SUBSCRIPTIONS_EXPORT_MAX_ROWS: 1000,
}));

import type { AdminSubscriptionRow } from '@client/app/utils/adminSubscriptionsFilter';
import handler from '../export';

const ADMIN = { id: 'a'.repeat(24), isAdmin: true };
type Handler = (req: unknown, res: unknown) => Promise<unknown>;

async function call(query: Record<string, string>, user: Record<string, unknown> = ADMIN) {
  const { req, res } = createMocks({ method: 'GET', query });
  const logger = { error: vi.fn() };
  Object.assign(req, { user, logger });
  const destroy = vi.spyOn(res, 'destroy');
  await (handler as unknown as Handler)(req, res);
  return { res, logger, destroy };
}

const makeRow = (index: number, overrides: Partial<AdminSubscriptionRow> = {}): AdminSubscriptionRow => ({
  id: index.toString(16).padStart(24, '0'),
  subscriptionId: `sub_${index}`,
  ownerType: 'Organization',
  ownerId: 'o'.repeat(24),
  owner: {
    kind: 'Organization',
    id: 'o'.repeat(24),
    name: 'Acme',
    stripeCustomerId: 'cus_acme',
    seats: 5,
    memberCount: 3,
    billingOwnerId: null,
  },
  plan: { priceId: 'price_team', name: 'Team', interval: 'monthly' },
  status: 'active',
  source: 'stripe',
  quantity: 4,
  customCreditsPerCycle: -412,
  periodStartsAt: '2026-06-01T00:00:00.000Z',
  periodEndsAt: '2026-07-01T00:00:00.000Z',
  canceledAt: null,
  createdAt: new Date(Date.UTC(2026, 0, 1) - index * 1000).toISOString(),
  ...overrides,
});

describe('GET /api/admin/subscriptions/export', () => {
  beforeEach(() => {
    mockPage.mockReset();
    mockMatch.mockReset();
    mockMatch.mockResolvedValue({ match: { status: 'x' }, searchTruncated: false });
    mockPage.mockResolvedValue([]);
  });

  it('requires JWT auth with admin scope', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
    });
  });

  it('refuses a non-admin before reading anything', async () => {
    await expect(call({}, { ...ADMIN, isAdmin: false })).rejects.toThrow('Admin access required');
    expect(mockPage).not.toHaveBeenCalled();
  });

  it('rejects an invalid filter with 400', async () => {
    expect((await call({ status: 'bogus' })).res._getStatusCode()).toBe(400);
    expect(mockPage).not.toHaveBeenCalled();
  });

  it('writes the header line and an empty export when nothing matches', async () => {
    const { res } = await call({ status: 'active' });
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    expect(res.getHeader('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(String(res.getHeader('Content-Disposition'))).toMatch(
      /^attachment; filename="subscriptions-\d{4}-\d{2}-\d{2}\.csv"$/
    );
    expect(mockMatch).toHaveBeenCalledWith({ status: ['active'] }, expect.any(Date), expect.any(Map));
    const lines = res._getData().split('\n');
    expect(lines[0].startsWith('"Created","Customer","Email"')).toBe(true);
    expect(lines[0].endsWith('"Subscription id"')).toBe(true);
    expect(lines).toHaveLength(2);
  });

  it('leaves numbers raw and guards a text cell that starts with =', async () => {
    mockPage.mockResolvedValueOnce([makeRow(1, { owner: null, ownerId: '=HYPERLINK("x")' })]);
    const { res } = await call({});
    const line = res._getData().split('\n')[1];
    expect(line).toContain(`"'=HYPERLINK(""x"")"`);
    expect(line).toContain(',4,,,-412,');
    expect(line).toContain('"Team"');
    expect(line.endsWith('"sub_1"')).toBe(true);
  });

  it('writes seats and members for an organization owner', async () => {
    mockPage.mockResolvedValueOnce([makeRow(1)]);
    const { res } = await call({});
    expect(res._getData().split('\n')[1]).toContain(',4,5,3,-412,');
  });

  it('pages by keyset, asking one extra row to probe for more', async () => {
    const firstPage = Array.from({ length: 501 }, (_, index) => makeRow(index + 1));
    const secondPage = [makeRow(600)];
    mockPage.mockResolvedValueOnce(firstPage).mockResolvedValueOnce(secondPage);

    const { res } = await call({});

    expect(mockPage).toHaveBeenCalledTimes(2);
    expect(mockPage.mock.calls[0].slice(0, 3)).toEqual([{ status: 'x' }, null, 501]);
    const cursor = { createdAt: new Date(firstPage[499].createdAt), id: firstPage[499].id };
    expect(mockPage.mock.calls[1].slice(0, 3)).toEqual([{ status: 'x' }, cursor, 501]);
    const lines = res._getData().trim().split('\n');
    expect(lines).toHaveLength(1 + 500 + 1);
    expect(res._getData()).not.toContain('# Truncated');
  });

  it('ends with a truncation line when the row cap is hit and more remain', async () => {
    mockPage.mockImplementation(async (_match, _after, limit: number) =>
      Array.from({ length: limit }, (_, index) => makeRow(index + 1))
    );

    const { res } = await call({});

    const lines = res._getData().trim().split('\n');
    expect(lines).toHaveLength(1 + 1000 + 1);
    expect(lines.at(-1)).toBe('# Truncated at 1,000 rows');
  });

  it('ends with a line saying so when the search resolved only some owners', async () => {
    mockMatch.mockResolvedValueOnce({ match: { status: 'x' }, searchTruncated: true });
    mockPage.mockResolvedValueOnce([makeRow(1)]);

    const { res } = await call({ search: 'gmail' });

    expect(res._getData().trim().split('\n').at(-1)).toBe(
      '# Search matched more than 500 owners; narrow it to export every match'
    );
  });

  it('cuts the connection when a read fails after the headers went out', async () => {
    mockPage.mockResolvedValueOnce(Array.from({ length: 501 }, (_, index) => makeRow(index + 1)));
    mockPage.mockRejectedValueOnce(new Error('mongo down'));

    const { res, logger, destroy } = await call({});

    expect(destroy).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('[ADMIN_SUBSCRIPTIONS_EXPORT_FAILED]', expect.anything());
    expect(res._isEndCalled()).toBe(false);
  });

  it('propagates a failure of the first read as an ordinary error', async () => {
    mockPage.mockRejectedValueOnce(new Error('mongo down'));
    await expect(call({})).rejects.toThrow('mongo down');
  });
});
