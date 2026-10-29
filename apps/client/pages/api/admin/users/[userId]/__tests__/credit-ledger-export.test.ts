import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ADMIN_LEDGER_EXPORT_MAX_ROWS, BadRequestError, ForbiddenError, NotFoundError } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  findLedgerPage: vi.fn(),
  sumNewer: vi.fn(),
  findUser: vi.fn(),
  findKey: vi.fn(),
  withTransaction: vi.fn(),
  inSnapshot: false,
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => handlers[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((handlers.GET = fns[fns.length - 1]), chain),
        _config: config,
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));
vi.mock('@bike4mind/database', () => ({
  creditTransactionRepository: { findLedgerPage: h.findLedgerPage, sumSignedCreditsNewerThan: h.sumNewer },
  userRepository: { findById: h.findUser },
  withTransaction: h.withTransaction,
}));
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: { findById: h.findKey } }));

import handler from '../credit-ledger-export';

const ADMIN = { id: 'admin1', isAdmin: true };
const OID = (n: number) => n.toString(16).padStart(24, '0');
const doc = (n: number, fields: Record<string, unknown>) => ({
  id: OID(n),
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)),
  ...fields,
});
const usageDoc = (n: number) => doc(n, { type: 'text_generation_usage', credits: -1 });

const run = (query: Record<string, string> = {}, user: unknown = ADMIN) => {
  const { req, res } = createMocks({ method: 'GET', query: { userId: 'u1', ...query } });
  (req as Record<string, unknown>).logger = { error: vi.fn() };
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const lines = (res: { _getData: () => string }) => res._getData().split('\n').filter(Boolean);

beforeEach(() => {
  vi.resetAllMocks();
  h.withTransaction.mockImplementation(async (fn: () => Promise<unknown>) => {
    h.inSnapshot = true;
    try {
      return await fn();
    } finally {
      h.inSnapshot = false;
    }
  });
  h.findUser.mockImplementation(async (id: string) => (id === 'u1' ? { id: 'u1', currentCredits: 100 } : null));
  h.findLedgerPage.mockResolvedValue([]);
});

describe('GET /api/admin/users/[userId]/credit-ledger-export', () => {
  it('requires the ADMIN scope and rejects non-admins and bad input before any read', async () => {
    expect((handler as unknown as { _config?: unknown })._config).toEqual({ auth: 'jwtOnly' });
    await expect(run({}, { id: 'u2', isAdmin: false }).promise).rejects.toBeInstanceOf(ForbiddenError);
    await expect(run({ kind: 'bogus' }).promise).rejects.toBeInstanceOf(BadRequestError);
    await expect(run({ userId: 'ghost' }).promise).rejects.toBeInstanceOf(NotFoundError);
    expect(h.findLedgerPage).not.toHaveBeenCalled();
  });

  it('sends CSV headers and a header row even for an empty ledger', async () => {
    const { res, promise } = run();
    await promise;

    expect(res.getHeader('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.getHeader('Content-Disposition')).toMatch(
      /^attachment; filename="credits-u1-all-\d{4}-\d{2}-\d{2}\.csv"$/
    );
    expect(lines(res)).toHaveLength(1);
    expect(lines(res)[0]).toContain('"Time","Kind","Type","Credits","Balance after"');
  });

  it('writes plain numbers, defuses text formulas and carries a running balance', async () => {
    h.findLedgerPage.mockResolvedValue([
      doc(2, { type: 'text_generation_usage', credits: -412, model: '@model', description: '=SUM(A1)' }),
      doc(1, { type: 'purchase', credits: 500, description: '+cmd|calc', reason: '-x' }),
    ]);

    const { res, promise } = run();
    await promise;

    const [, first, second] = lines(res);
    expect(first).toContain(',-412,100,');
    expect(first).toContain(`"'@model"`);
    expect(first).toContain(`"'=SUM(A1)"`);
    expect(second).toContain(',500,512,');
    expect(second).toContain(`"'+cmd|calc"`);
    expect(second).toContain(`"'-x"`);
    expect(first).not.toContain(`'-412`);
  });

  it('reads the balance and the first page from one snapshot and later pages outside it', async () => {
    const seen: boolean[] = [];
    h.findUser.mockImplementation(async () => (seen.push(h.inSnapshot), { id: 'u1', currentCredits: 100 }));
    h.findLedgerPage
      .mockImplementationOnce(
        async () => (seen.push(h.inSnapshot), Array.from({ length: 501 }, (_, i) => usageDoc(600 - i)))
      )
      .mockImplementationOnce(async () => (seen.push(h.inSnapshot), [usageDoc(1)]));

    const { res, promise } = run();
    await promise;

    expect(seen).toEqual([true, true, false]);
    expect(h.withTransaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      readConcern: { level: 'snapshot' },
    });
    const all = lines(res);
    expect(all).toHaveLength(502);
    expect(all[501]).toContain(',-1,600,');
  });

  it('passes the kind through to the repository and writes no balance for non-adjustments', async () => {
    h.findLedgerPage.mockResolvedValue([usageDoc(1)]);
    const { res, promise } = run({ kind: 'purchase' });
    await promise;

    expect(h.findLedgerPage).toHaveBeenCalledWith('u1', 'User', expect.objectContaining({ types: ['purchase'] }));
    expect(res.getHeader('Content-Disposition')).toContain('-purchase-');
    expect(h.sumNewer).not.toHaveBeenCalled();
  });

  it('stops at the cap, bounds the loop and appends a truncation line', async () => {
    let next = 1_000_000;
    h.findLedgerPage.mockImplementation(async (_o: string, _t: string, { limit }: { limit: number }) =>
      Array.from({ length: limit }, () => usageDoc(next--))
    );

    const { res, promise } = run();
    await promise;

    const all = lines(res);
    expect(all.at(-1)).toBe('# Truncated at 10,000 rows');
    expect(all).toHaveLength(1 + ADMIN_LEDGER_EXPORT_MAX_ROWS + 1);
    expect(h.findLedgerPage).toHaveBeenCalledTimes(Math.ceil(ADMIN_LEDGER_EXPORT_MAX_ROWS / 500));
  });

  it('does not flag truncation when the ledger ends exactly at the cap', async () => {
    let remaining = ADMIN_LEDGER_EXPORT_MAX_ROWS;
    let next = 1_000_000;
    h.findLedgerPage.mockImplementation(async (_o: string, _t: string, { limit }: { limit: number }) => {
      const count = Math.min(limit, remaining);
      remaining -= Math.min(count, limit - 1);
      return Array.from({ length: count }, () => usageDoc(next--));
    });

    const { res, promise } = run();
    await promise;

    expect(lines(res).some(line => line.startsWith('# Truncated'))).toBe(false);
  });

  it('propagates a first-page failure as an error before any bytes are sent', async () => {
    h.findLedgerPage.mockRejectedValue(new Error('db down'));
    const { res, promise } = run();
    await expect(promise).rejects.toThrow('db down');
    expect(res._getData()).toBe('');
  });

  it('exports under the same model, source and date filter as the ledger, without a balance', async () => {
    h.findLedgerPage.mockResolvedValue([usageDoc(1)]);
    const { res, promise } = run({ model: 'm1', source: 'api', from: '2026-01-01', to: '2026-01-02' });
    await promise;

    expect(h.findLedgerPage).toHaveBeenCalledWith(
      'u1',
      'User',
      expect.objectContaining({
        model: 'm1',
        source: 'api',
        createdFrom: new Date('2026-01-01T00:00:00.000Z'),
        createdBefore: new Date('2026-01-03T00:00:00.000Z'),
      })
    );
    expect(h.sumNewer).not.toHaveBeenCalled();
    expect(lines(res)[1]).toContain(',-1,,');
    expect(res.getHeader('Content-Disposition')).toMatch(/filename="credits-u1-all-filtered-\d{4}-\d{2}-\d{2}\.csv"/);
  });

  it('rejects a start date after the end date before any read', async () => {
    await expect(run({ from: '2026-02-02', to: '2026-02-01' }).promise).rejects.toBeInstanceOf(BadRequestError);
    expect(h.findLedgerPage).not.toHaveBeenCalled();
  });

  it('starts the balance of a range ending in the past below every newer row, inside the snapshot', async () => {
    const seen: boolean[] = [];
    h.sumNewer.mockImplementation(async () => (seen.push(h.inSnapshot), -40));
    h.findLedgerPage.mockResolvedValue([usageDoc(2), usageDoc(1)]);

    const { res, promise } = run({ to: '2026-01-01' });
    await promise;

    expect(seen).toEqual([true]);
    const [, first, second] = lines(res);
    expect(first).toContain(',-1,140,');
    expect(second).toContain(',-1,141,');
  });

  it('appends the request id and quest id columns after the existing ones', async () => {
    h.findLedgerPage.mockResolvedValue([
      doc(2, { type: 'completion_api_usage', credits: -1, metadata: { requestId: 'completion-k1-1' } }),
      doc(1, { type: 'text_generation_usage', credits: -1, questId: 'q-42' }),
    ]);
    const { res, promise } = run();
    await promise;

    const [header, api, chat] = lines(res);
    expect(header.endsWith('"Admin note","Request id","Quest id"')).toBe(true);
    expect(api.endsWith(',"completion-k1-1",""')).toBe(true);
    expect(chat.endsWith(',"","q-42"')).toBe(true);
  });
});
