// @vitest-environment node
/**
 * Route tests for `GET /api/v1/credits`.
 *
 * Same harness as v1Me.test.ts: `baseApi` is stubbed but `nextRouteForContract` is
 * not, so the contract's response drift check runs for real, and the captured
 * baseApi options are how the scope gate is asserted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope, CreditBalanceSchema } from '@bike4mind/common';

const { baseApiOptions } = vi.hoisted(() => ({ baseApiOptions: [] as unknown[] }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    baseApiOptions.push(options);
    const compose =
      (...handlers: ((req: unknown, res: unknown, next: () => void) => unknown)[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of handlers) {
          let advanced = false;
          await handler(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      };
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.get = compose;
    return chain;
  },
}));

const { default: handler } = await import('@pages/api/v1/credits');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const caller = { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com', currentCredits: 1234 };

function get() {
  const { req, res } = createMocks({ method: 'GET' });
  Object.assign(req, { user: caller, logger });
  return { req, res };
}

async function run(req: unknown, res: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (handler as any)(req, res);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/credits', () => {
  it("returns only the caller's balance, matching the published schema", async () => {
    const { req, res } = get();

    await run(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(CreditBalanceSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({ balance: 1234 });
  });

  it('marks the response private and uncacheable', async () => {
    const { req, res } = get();

    await run(req, res);

    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });

  it('admits me:read, ai:chat and ai:generate keys, and exempts reads from the daily limit', () => {
    expect(baseApiOptions[0]).toMatchObject({
      auth: true,
      requiredScopes: [ApiKeyScope.ME_READ, ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE],
      exemptReadsFromDailyRateLimit: true,
    });
  });
});
