// @vitest-environment node
/**
 * Route tests for GET /api/v1/credits/transactions. `baseApi` is stubbed (no DB connect, no auth chain) but
 * records the options `nextRouteForContract` hands it, and the contract adapter itself runs for real, so
 * query validation and the response drift check are exercised.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFindLedgerPage, baseApiOptions } = vi.hoisted(() => ({
  mockFindLedgerPage: vi.fn(),
  baseApiOptions: [] as Array<Record<string, unknown> | undefined>,
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options?: Record<string, unknown>) => {
    baseApiOptions.push(options);
    type Mw = (req: unknown, res: unknown, next: () => void) => unknown;
    const used: Mw[] = [];
    const compose =
      (...handlers: Mw[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of [...used, ...handlers]) {
          let advanced = false;
          await handler(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      };
    const chain: Record<string, unknown> = {};
    chain.use = (mw: Mw) => {
      used.push(mw);
      return chain;
    };
    chain.get = compose;
    return chain;
  },
  methodNotAllowedHandler: () => (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
    res.status(405).json({ error: 'Method not allowed' }),
}));
vi.mock('@bike4mind/database', () => ({ creditTransactionRepository: { findLedgerPage: mockFindLedgerPage } }));

const { default: handler } = await import('@pages/api/v1/credits/transactions');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const USER_ID = '65b000000000000000000001';

// Newest first. The first two share a timestamp, so paging must break the tie on id.
const ROWS = [
  { id: '65e000000000000000000003', type: 'text_generation_usage', credits: -12, at: '2026-03-02T09:00:00.000Z' },
  { id: '65e000000000000000000002', type: 'purchase', credits: 5000, at: '2026-03-02T09:00:00.000Z' },
  // Writers disagree on the sign of a stored deduct row; the public sign comes from the type.
  { id: '65e000000000000000000001', type: 'generic_deduct', credits: 40, at: '2026-03-01T09:00:00.000Z' },
].map(({ id, type, credits, at }) => ({
  id,
  type,
  credits,
  description: `row ${id}`,
  source: 'api',
  createdAt: new Date(at),
  updatedAt: new Date(at),
  ownerId: USER_ID,
  // Internal fields that must not reach the wire.
  metadata: { actorId: 'admin-internal' },
  stripePaymentIntentId: 'pi_secret',
}));

async function run({
  query = {},
  apiKeyInfo,
}: { query?: Record<string, string>; apiKeyInfo?: { keyId: string } } = {}) {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { user: { id: USER_ID }, logger, ...(apiKeyInfo && { apiKeyInfo }) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the contract router's param type carries prelude-only fields
  await (handler as any)(req, res);
  return res;
}

async function errorOf(query: Record<string, string>): Promise<{ statusCode?: number; name?: string }> {
  try {
    await run({ query });
  } catch (err) {
    return err as { statusCode?: number; name?: string };
  }
  throw new Error('expected the handler to throw');
}

beforeEach(() => {
  vi.clearAllMocks();
  // Stands in for the repo: newest first by (createdAt, id), strictly after `after`, at most `limit`.
  mockFindLedgerPage.mockImplementation(
    async (
      _ownerId: string,
      _ownerType: string,
      { limit, after }: { limit: number; after?: { createdAt: Date; id: string } }
    ) =>
      ROWS.filter(
        r =>
          !after ||
          r.createdAt < after.createdAt ||
          (r.createdAt.getTime() === after.createdAt.getTime() && r.id < after.id)
      ).slice(0, limit)
  );
});

describe('GET /api/v1/credits/transactions', () => {
  it("lists the caller's own ledger newest first with only public fields and a signed amount", async () => {
    const res = await run();
    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    const body = res._getJSONData();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(body.data.map((tx: { id: string }) => tx.id)).toEqual(ROWS.map(r => r.id));
    expect(body.next_cursor).toBeNull();
    expect(body.data[0]).toEqual({
      id: ROWS[0].id,
      type: 'text_generation_usage',
      credits: -12,
      description: `row ${ROWS[0].id}`,
      source: 'api',
      createdAt: '2026-03-02T09:00:00.000Z',
    });
    expect(body.data[1].credits).toBe(5000);
    expect(body.data[2].credits).toBe(-40);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('pi_secret');
    expect(serialized).not.toContain('admin-internal');
    expect(serialized).not.toContain(USER_ID);
    expect(mockFindLedgerPage).toHaveBeenCalledWith(
      USER_ID,
      'User',
      expect.objectContaining({ types: undefined, limit: 26 })
    );
  });

  it('round-trips the cursor across a timestamp tie and ends with next_cursor null', async () => {
    const first = (await run({ query: { limit: '1' } }))._getJSONData();
    expect(first.data.map((tx: { id: string }) => tx.id)).toEqual([ROWS[0].id]);
    expect(first.next_cursor).toEqual(expect.any(String));

    const second = (await run({ query: { limit: '1', cursor: first.next_cursor } }))._getJSONData();
    expect(second.data.map((tx: { id: string }) => tx.id)).toEqual([ROWS[1].id]);

    const third = (await run({ query: { limit: '1', cursor: second.next_cursor } }))._getJSONData();
    expect(third.data.map((tx: { id: string }) => tx.id)).toEqual([ROWS[2].id]);
    expect(third.next_cursor).toBeNull();
    expect(mockFindLedgerPage).toHaveBeenLastCalledWith(
      USER_ID,
      'User',
      expect.objectContaining({ after: { createdAt: ROWS[1].createdAt, id: ROWS[1].id }, limit: 2 })
    );
  });

  it('maps the direction filter to ledger types and bounds the window by days', async () => {
    const before = Date.now();
    await run({ query: { type: 'added', days: '7' } });
    const added = mockFindLedgerPage.mock.calls[0][2];
    expect(added.types).toContain('purchase');
    expect(added.types).not.toContain('text_generation_usage');
    const windowMs = before - added.createdFrom.getTime();
    expect(windowMs).toBeGreaterThanOrEqual(7 * 24 * 3600_000 - 3600_000);
    expect(windowMs).toBeLessThanOrEqual(7 * 24 * 3600_000 + 3600_000);

    await run({ query: { type: 'deducted' } });
    const deducted = mockFindLedgerPage.mock.calls[1][2];
    expect(deducted.types).toContain('text_generation_usage');
    expect(deducted.types).not.toContain('purchase');
  });

  it('is open to an API key or a JWT, gated on me:read', async () => {
    expect(baseApiOptions[0]).toMatchObject({ auth: true, requiredScopes: ['me:read'] });
    expect((await run({ apiKeyInfo: { keyId: 'k1' } }))._getStatusCode()).toBe(200);
    expect((await run())._getStatusCode()).toBe(200);
  });

  it('rejects a bad limit, window, filter or cursor before reading the ledger', async () => {
    expect((await errorOf({ limit: '0' })).name).toBe('ZodError');
    expect((await errorOf({ days: '0' })).name).toBe('ZodError');
    expect((await errorOf({ days: '99999999999999' })).name).toBe('ZodError');
    expect((await errorOf({ type: 'refunds' })).name).toBe('ZodError');
    expect((await errorOf({ cursor: 'not-a-cursor' })).statusCode).toBe(422);
    const foreign = Buffer.from(JSON.stringify({ v: 1, s: 'v1.session-quests', after: 'x|y' })).toString('base64url');
    expect((await errorOf({ cursor: foreign })).statusCode).toBe(422);
    expect(mockFindLedgerPage).not.toHaveBeenCalled();
  });
});
