import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { adminUserRiskFlagsSchema, ApiKeyScope } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  listUserSignIns: vi.fn(),
  summarizeAiSpend: vi.fn(),
  findIncidents: vi.fn(),
}));

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
  userRepository: { findById: (...a: unknown[]) => mocks.findById(...a) },
  creditTransactionRepository: { summarizeAiSpend: (...a: unknown[]) => mocks.summarizeAiSpend(...a) },
  imageModerationIncidentRepository: { find: (...a: unknown[]) => mocks.findIncidents(...a) },
}));
vi.mock('@server/utils/userSignIns', () => ({
  listUserSignIns: (...a: unknown[]) => mocks.listUserSignIns(...a),
}));

import handler from '../risk-flags';

const USER_ID = 'b'.repeat(24);
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);

const call = (query: Record<string, string> = {}, user: unknown = { id: 'admin1', isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'GET', query: { userId: USER_ID, ...query } });
  if (user) (req as Record<string, unknown>).user = user;
  return { req, res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const failedSignIn = (i: number) => ({
  id: `f${i}`,
  at: ago(HOUR + i * 1000),
  result: 'blocked',
  event: 'blocked',
  ip: '203.0.113.9',
});

const flagIds = (res: { _getJSONData: () => unknown }) =>
  (res._getJSONData() as { flags: Array<{ id: string }> }).flags.map(f => f.id);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findById.mockResolvedValue({ id: USER_ID, loginRecords: [] });
  mocks.listUserSignIns.mockResolvedValue({ entries: [], nextCursor: null });
  mocks.summarizeAiSpend.mockResolvedValue({ dailyCredits: [] });
  mocks.findIncidents.mockResolvedValue([]);
});

describe('GET /api/admin/users/[userId]/risk-flags', () => {
  it('declares requiredScopes [ApiKeyScope.ADMIN]', () => {
    expect((handler as unknown as { _config?: { requiredScopes?: string[] } })._config?.requiredScopes).toEqual([
      ApiKeyScope.ADMIN,
    ]);
  });

  it('rejects a non-admin with 403 before reading anything', async () => {
    await expect(call({}, { id: 'u2', isAdmin: false }).promise).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it('rejects a malformed id with 400 and an unknown user with 404', async () => {
    await expect(call({ userId: 'nope' }).promise).rejects.toMatchObject({ statusCode: 400 });
    mocks.findById.mockResolvedValue(null);
    await expect(call().promise).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns no flags for a user with no history', async () => {
    const { res, promise } = call();
    await promise;
    const body = res._getJSONData();
    expect(adminUserRiskFlagsSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({ flags: [] });
  });

  it('fires the failed sign-in rule from audit entries', async () => {
    mocks.listUserSignIns.mockResolvedValue({
      entries: Array.from({ length: 5 }, (_, i) => failedSignIn(i)),
      nextCursor: null,
    });
    const { res, promise } = call();
    await promise;
    expect(adminUserRiskFlagsSchema.safeParse(res._getJSONData()).success).toBe(true);
    expect(flagIds(res)).toEqual(['failed_sign_ins']);
  });

  it('fires the credit spike rule from the daily spend series', async () => {
    const daily = Array.from({ length: 37 }, (_, i) => ({
      day: new Date(Date.now() - i * 24 * HOUR).toISOString().slice(0, 10),
      credits: i < 7 ? 500 : 50,
    }));
    mocks.summarizeAiSpend.mockResolvedValue({ dailyCredits: daily });
    const { res, promise } = call();
    await promise;
    expect(flagIds(res)).toEqual(['credit_spike']);
  });

  it('fires the moderation rule from recent incidents', async () => {
    mocks.findIncidents.mockResolvedValue([{ createdAt: ago(2 * 24 * HOUR), labels: [{ name: 'Explicit' }] }]);
    const { res, promise } = call();
    await promise;
    expect(flagIds(res)).toEqual(['prior_moderation']);
  });

  it('fires the new IP rule when the latest success comes from an unseen address', async () => {
    const success = (id: string, at: Date, ip: string) => ({ id, at, result: 'success', event: 'login', ip });
    mocks.listUserSignIns.mockResolvedValue({
      entries: [
        success('n', ago(HOUR), '198.51.100.7'),
        success('a', ago(30 * 24 * HOUR), '203.0.113.1'),
        success('b', ago(31 * 24 * HOUR), '203.0.113.1'),
        success('c', ago(32 * 24 * HOUR), '203.0.113.1'),
      ],
      nextCursor: null,
    });
    const { res, promise } = call();
    await promise;
    expect(flagIds(res)).toEqual(['new_ip_or_device']);
  });
});
