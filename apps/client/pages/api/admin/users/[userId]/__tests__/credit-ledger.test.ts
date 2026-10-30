import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ForbiddenError, BadRequestError, NotFoundError } from '@bike4mind/common';

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

import handler from '../credit-ledger';
import { encodeLedgerCursor } from '@server/utils/adminCreditLedger';

const ADMIN = { id: 'admin1', isAdmin: true };
const OID = (n: number) => n.toString(16).padStart(24, '0');
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

type Doc = Record<string, unknown> & { id: string; createdAt: Date };
const doc = (n: number, fields: Record<string, unknown>): Doc => ({
  id: OID(n),
  createdAt: at(n),
  ownerId: 'u1',
  ...fields,
});

const run = (query: Record<string, string> = {}, user: unknown = ADMIN) => {
  const { req, res } = createMocks({ method: 'GET', query: { userId: 'u1', ...query } });
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

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
  h.findUser.mockImplementation(async (id: string) =>
    id === 'u1' ? { id: 'u1', currentCredits: 1000 } : id === OID(900) ? { id, name: 'Ada Admin' } : null
  );
  h.findLedgerPage.mockResolvedValue([]);
  h.sumNewer.mockResolvedValue(0);
});

describe('GET /api/admin/users/[userId]/credit-ledger', () => {
  it('requires the ADMIN scope and rejects non-admins before any read', async () => {
    expect((handler as unknown as { _config?: unknown })._config).toEqual({ auth: 'jwtOnly' });
    const { promise } = run({}, { id: 'u2', isAdmin: false });
    await expect(promise).rejects.toBeInstanceOf(ForbiddenError);
    expect(h.findUser).not.toHaveBeenCalled();
    expect(h.findLedgerPage).not.toHaveBeenCalled();
  });

  it('404s for an unknown user', async () => {
    const { promise } = run({ userId: 'ghost' });
    await expect(promise).rejects.toBeInstanceOf(NotFoundError);
  });

  it('400s on an invalid cursor and an invalid kind without querying', async () => {
    await expect(run({ cursor: 'not-a-cursor' }).promise).rejects.toBeInstanceOf(BadRequestError);
    await expect(
      run({ cursor: Buffer.from(JSON.stringify({ c: 'nope', i: 'x' })).toString('base64url') }).promise
    ).rejects.toBeInstanceOf(BadRequestError);
    await expect(run({ kind: 'bogus' }).promise).rejects.toBeInstanceOf(BadRequestError);
    expect(h.findLedgerPage).not.toHaveBeenCalled();
  });

  it('returns the first page with a running balance from the current balance and no aggregation', async () => {
    h.findLedgerPage.mockResolvedValue([
      doc(3, { type: 'text_generation_usage', credits: -5, model: 'm1', inputTokens: 10, outputTokens: 20 }),
      doc(2, { type: 'purchase', credits: 100 }),
      doc(1, { type: 'generic_deduct', credits: 7 }),
    ]);

    const { res, promise } = run();
    await promise;

    const body = res._getJSONData();
    expect(body.nextCursor).toBeNull();
    expect(body.rows.map((r: { credits: number }) => r.credits)).toEqual([-5, 100, -7]);
    expect(body.rows.map((r: { balanceAfter: number }) => r.balanceAfter)).toEqual([1000, 1005, 905]);
    expect(body.rows[0]).toMatchObject({ kind: 'usage', model: 'm1', inputTokens: 10, outputTokens: 20 });
    expect(h.sumNewer).not.toHaveBeenCalled();
    expect(h.findLedgerPage).toHaveBeenCalledWith('u1', 'User', { types: undefined, after: undefined, limit: 51 });
  });

  it('continues after a cursor and subtracts everything newer than the first row of the page', async () => {
    const cursor = encodeLedgerCursor({ createdAt: at(5), id: OID(5) });
    h.sumNewer.mockResolvedValue(-40);
    h.findLedgerPage.mockResolvedValue([doc(4, { type: 'text_generation_usage', credits: -3 })]);

    const { res, promise } = run({ cursor });
    await promise;

    expect(h.findLedgerPage).toHaveBeenCalledWith(
      'u1',
      'User',
      expect.objectContaining({ after: { createdAt: at(5), id: OID(5) } })
    );
    expect(h.sumNewer).toHaveBeenCalledExactlyOnceWith('u1', 'User', { createdAt: at(4), id: OID(4) });
    expect(res._getJSONData().rows[0].balanceAfter).toBe(1040);
  });

  it('reads the balance, the page and the newer-rows sum from one snapshot', async () => {
    const seen: boolean[] = [];
    h.findUser.mockImplementation(async () => (seen.push(h.inSnapshot), { id: 'u1', currentCredits: 1000 }));
    h.findLedgerPage.mockImplementation(
      async () => (seen.push(h.inSnapshot), [doc(4, { type: 'purchase', credits: 1 })])
    );
    h.sumNewer.mockImplementation(async () => (seen.push(h.inSnapshot), 0));

    await run({ cursor: encodeLedgerCursor({ createdAt: at(5), id: OID(5) }) }).promise;

    expect(seen).toEqual([true, true, true]);
    expect(h.withTransaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      readConcern: { level: 'snapshot' },
    });
  });

  it('warns when the derived balance disagrees with an adjustment recorded balance', async () => {
    h.findLedgerPage.mockResolvedValue([
      doc(2, { type: 'text_generation_usage', credits: -5 }),
      doc(1, { type: 'generic_add', credits: 50, metadata: { resultingBalance: 990 } }),
    ]);
    const { req, res } = createMocks({ method: 'GET', query: { userId: 'u1' } });
    const warn = vi.fn();
    Object.assign(req, { user: ADMIN, logger: { warn } });
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);

    expect(res._getJSONData().rows[1].balanceAfter).toBe(1005);
    expect(warn).toHaveBeenCalledExactlyOnceWith('[ADMIN_LEDGER_BALANCE_DRIFT]', {
      userId: 'u1',
      transactionId: OID(1),
      derived: 1005,
      recorded: 990,
    });
  });

  it('returns a nextCursor from the last visible row when the probe row exists', async () => {
    h.findLedgerPage.mockResolvedValue([
      doc(3, { type: 'purchase', credits: 1 }),
      doc(2, { type: 'purchase', credits: 1 }),
      doc(1, { type: 'purchase', credits: 1 }),
    ]);

    const { res, promise } = run({ limit: '2' });
    await promise;

    const body = res._getJSONData();
    expect(body.rows).toHaveLength(2);
    expect(body.nextCursor).toBe(encodeLedgerCursor({ createdAt: at(2), id: OID(2) }));
    expect(h.findLedgerPage).toHaveBeenCalledWith('u1', 'User', expect.objectContaining({ limit: 3 }));
  });

  it('filters by kind and only admin adjustments carry a recorded balance', async () => {
    h.findLedgerPage.mockResolvedValue([
      doc(2, {
        type: 'generic_add',
        credits: 50,
        reason: 'admin_adjustment',
        metadata: { actorId: OID(900), resultingBalance: 777, note: 'goodwill' },
      }),
      doc(1, { type: 'generic_deduct', credits: -5, reason: 'credit_expiry' }),
    ]);

    const { res, promise } = run({ kind: 'adjustment' });
    await promise;

    expect(h.findLedgerPage).toHaveBeenCalledWith(
      'u1',
      'User',
      expect.objectContaining({ types: expect.arrayContaining(['generic_add', 'generic_deduct']) })
    );
    expect(h.sumNewer).not.toHaveBeenCalled();
    const [first, second] = res._getJSONData().rows;
    expect(first).toMatchObject({ balanceAfter: 777, note: 'goodwill', actorId: OID(900), actorName: 'Ada Admin' });
    expect(second.balanceAfter).toBeUndefined();
    expect(second).toMatchObject({ reason: 'credit_expiry', credits: -5 });
  });

  it('resolves each distinct API key once to a prefix only', async () => {
    h.findKey.mockResolvedValue({ keyPrefix: 'b4m_live_abcd', keyHash: 'secret-hash', keyDigest: 'secret-digest' });
    h.findLedgerPage.mockResolvedValue([
      doc(3, { type: 'completion_api_usage', credits: -1, apiKeyId: OID(77) }),
      doc(2, { type: 'completion_api_usage', credits: -1, apiKeyId: OID(77) }),
      doc(1, { type: 'completion_api_usage', credits: -1, apiKeyId: 'not-an-object-id' }),
    ]);

    const { res, promise } = run();
    await promise;

    expect(h.findKey).toHaveBeenCalledTimes(1);
    const rows = res._getJSONData().rows;
    expect(rows[0]).toMatchObject({ apiKeyId: OID(77), apiKeyPrefix: 'b4m_live_abcd', kind: 'api' });
    expect(rows[2].apiKeyPrefix).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain('secret');
  });

  it('400s on a bad source, a bad date and a start date after the end date without querying', async () => {
    await expect(run({ source: 'carrier-pigeon' }).promise).rejects.toBeInstanceOf(BadRequestError);
    await expect(run({ from: '2026-13-40' }).promise).rejects.toBeInstanceOf(BadRequestError);
    await expect(run({ from: '2026-02-02', to: '2026-02-01' }).promise).rejects.toBeInstanceOf(BadRequestError);
    expect(h.findLedgerPage).not.toHaveBeenCalled();
  });

  it('passes model, source and whole UTC days to the repository and derives no balance', async () => {
    h.findLedgerPage.mockResolvedValue([doc(1, { type: 'text_generation_usage', credits: -5, model: 'm1' })]);

    const { res, promise } = run({ model: 'm1', source: 'cli', from: '2026-01-01', to: '2026-01-31' });
    await promise;

    expect(h.findLedgerPage).toHaveBeenCalledExactlyOnceWith('u1', 'User', {
      types: undefined,
      model: 'm1',
      source: 'cli',
      createdFrom: new Date('2026-01-01T00:00:00.000Z'),
      createdBefore: new Date('2026-02-01T00:00:00.000Z'),
      after: undefined,
      limit: 51,
    });
    expect(h.sumNewer).not.toHaveBeenCalled();
    expect(res._getJSONData().rows[0].balanceAfter).toBeUndefined();
  });

  it('keeps the running balance under a date range, starting below everything newer than the range', async () => {
    h.sumNewer.mockResolvedValue(-40);
    h.findLedgerPage.mockResolvedValue([
      doc(2, { type: 'text_generation_usage', credits: -5 }),
      doc(1, { type: 'purchase', credits: 100 }),
    ]);

    const { res, promise } = run({ to: '2026-01-01' });
    await promise;

    expect(h.sumNewer).toHaveBeenCalledExactlyOnceWith('u1', 'User', { createdAt: at(2), id: OID(2) });
    expect(res._getJSONData().rows.map((r: { balanceAfter: number }) => r.balanceAfter)).toEqual([1040, 1045]);
  });

  it('starts at the current balance when the range has only a start date', async () => {
    h.findLedgerPage.mockResolvedValue([doc(1, { type: 'text_generation_usage', credits: -5 })]);

    const { res, promise } = run({ from: '2026-01-01' });
    await promise;

    expect(h.sumNewer).not.toHaveBeenCalled();
    expect(res._getJSONData().rows[0].balanceAfter).toBe(1000);
  });

  it('reports the API request id and the chat quest id as separate fields', async () => {
    h.findLedgerPage.mockResolvedValue([
      doc(3, { type: 'completion_api_usage', credits: -1, metadata: { requestId: 'completion-k1-1' } }),
      doc(2, { type: 'text_generation_usage', credits: -1, questId: 'q-42' }),
      doc(1, { type: 'purchase', credits: 10 }),
    ]);

    const { res, promise } = run();
    await promise;

    const rows = res._getJSONData().rows as Array<{ requestId?: string; questId?: string }>;
    expect(rows.map(r => [r.requestId, r.questId])).toEqual([
      ['completion-k1-1', undefined],
      [undefined, 'q-42'],
      [undefined, undefined],
    ]);
  });
});
