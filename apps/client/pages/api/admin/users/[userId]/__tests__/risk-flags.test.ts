import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { adminUserRiskFlagsSchema, ApiKeyScope } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  listUserRiskSignIns: vi.fn(),
  summarizeAiSpend: vi.fn(),
  findIncidents: vi.fn(),
  incidentSelect: vi.fn(),
  incidentMaxTime: vi.fn(),
  incidentClose: vi.fn(),
  incidentBatchError: undefined as Error | undefined,
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
  ImageModerationIncident: {
    find: (...args: unknown[]) => {
      const query = {
        select: (...fields: unknown[]) => {
          mocks.incidentSelect(...fields);
          return query;
        },
        maxTimeMS: (...limits: unknown[]) => {
          mocks.incidentMaxTime(...limits);
          return query;
        },
        lean: () => query,
        cursor: () => ({
          close: async () => {
            mocks.incidentClose();
          },
          async *[Symbol.asyncIterator]() {
            const incidents = (await mocks.findIncidents(...args)) as unknown[];
            for (const incident of incidents) yield incident;
            if (mocks.incidentBatchError) throw mocks.incidentBatchError;
          },
        }),
      };
      return query;
    },
  },
}));
vi.mock('@server/utils/userSignIns', () => ({
  listUserRiskSignIns: (...a: unknown[]) => mocks.listUserRiskSignIns(...a),
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
  mocks.incidentBatchError = undefined;
  mocks.findById.mockResolvedValue({ id: USER_ID, loginRecords: [] });
  mocks.listUserRiskSignIns.mockResolvedValue([]);
  mocks.summarizeAiSpend.mockResolvedValue({ dailyCredits: [] });
  mocks.findIncidents.mockResolvedValue([]);
});

describe('GET /api/admin/users/[userId]/risk-flags', () => {
  it('declares requiredScopes [ApiKeyScope.ADMIN]', () => {
    expect((handler as unknown as { _config?: { requiredScopes?: string[] } })._config?.requiredScopes).toEqual([
      ApiKeyScope.ADMIN,
    ]);
  });

  it('is JWT-only so an API key can never read the IP evidence', () => {
    expect((handler as unknown as { _config?: { auth?: string } })._config?.auth).toBe('jwtOnly');
  });

  it('bounds the complete risk reads to their rule windows and projects moderation evidence', async () => {
    await call().promise;
    expect(mocks.listUserRiskSignIns).toHaveBeenCalledWith(USER_ID, [], expect.any(Date), 24);
    const now = mocks.listUserRiskSignIns.mock.calls[0][2] as Date;
    expect(mocks.findIncidents).toHaveBeenCalledWith({
      userId: USER_ID,
      reviewStatus: { $ne: 'false_positive' },
      createdAt: { $gte: new Date(now.getTime() - 30 * 24 * HOUR), $lte: now },
    });
    expect(mocks.incidentSelect).toHaveBeenCalledWith('createdAt labels.name reviewStatus');
    expect(mocks.incidentMaxTime).toHaveBeenCalledWith(15_000);
  });

  it('keeps failed sign-ins when more than 200 newer successes exist', async () => {
    mocks.listUserRiskSignIns.mockResolvedValue([
      ...Array.from({ length: 201 }, (_, index) => ({
        id: `s${index}`,
        at: ago(HOUR / 2),
        result: 'success',
        event: 'login_success',
      })),
      ...Array.from({ length: 5 }, (_, index) => failedSignIn(index)),
    ]);
    const { res, promise } = call();
    await promise;
    expect(flagIds(res)).toEqual(['failed_sign_ins']);
  });

  it('keeps old known addresses and novel recent sign-ins past the first 200 successes', async () => {
    const success = (id: string, ageHours: number, ip: string) => ({
      id,
      at: ago(ageHours * HOUR),
      result: 'success',
      event: 'login_success',
      ip,
    });
    const prior = Array.from({ length: 201 }, (_, index) => success(`p${index}`, 240 + index, '203.0.113.1'));
    mocks.listUserRiskSignIns.mockResolvedValue([
      success('recent', 1, '198.51.100.7'),
      ...prior,
      success('old-known', 720, '198.51.100.7'),
    ]);
    const known = call();
    await known.promise;
    expect(flagIds(known.res)).toEqual([]);

    mocks.listUserRiskSignIns.mockResolvedValue([
      ...Array.from({ length: 201 }, (_, index) => success(`r${index}`, 1, '203.0.113.1')),
      success('novel', 2, '198.51.100.8'),
      ...prior,
    ]);
    const novel = call();
    await novel.promise;
    expect(flagIds(novel.res)).toEqual(['new_ip_or_device']);
  });

  it('reports all moderation incidents and labels beyond the former 50-row cap', async () => {
    mocks.findIncidents.mockResolvedValue([
      ...Array.from({ length: 50 }, () => ({ createdAt: ago(HOUR), labels: [{ name: 'A' }] })),
      { createdAt: ago(2 * HOUR), labels: [{ name: 'Older label' }] },
    ]);
    const { res, promise } = call();
    await promise;
    expect(res._getJSONData().flags[0].evidence).toContainEqual({ label: 'Moderation incidents', value: '51' });
    expect(res._getJSONData().flags[0].evidence).toContainEqual({ label: 'Labels', value: 'A, Older label' });
  });

  it('rejects and closes the moderation cursor when a later batch fails', async () => {
    const error = new Error('Later moderation batch failed');
    mocks.findIncidents.mockResolvedValue([{ createdAt: ago(HOUR), labels: [{ name: 'A' }] }]);
    mocks.incidentBatchError = error;
    await expect(call().promise).rejects.toBe(error);
    expect(mocks.incidentClose).toHaveBeenCalledOnce();
  });

  it.each(['signIns', 'spend', 'moderation'])(
    'propagates a failed %s read instead of returning no flags',
    async source => {
      const error = new Error('Store unavailable');
      if (source === 'signIns') mocks.listUserRiskSignIns.mockRejectedValueOnce(error);
      if (source === 'spend') mocks.summarizeAiSpend.mockRejectedValueOnce(error);
      if (source === 'moderation') mocks.findIncidents.mockRejectedValueOnce(error);
      await expect(call().promise).rejects.toBe(error);
    }
  );

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
    mocks.listUserRiskSignIns.mockResolvedValue(Array.from({ length: 5 }, (_, i) => failedSignIn(i)));
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
    mocks.listUserRiskSignIns.mockResolvedValue([
      success('n', ago(HOUR), '198.51.100.7'),
      success('a', ago(30 * 24 * HOUR), '203.0.113.1'),
      success('b', ago(31 * 24 * HOUR), '203.0.113.1'),
      success('c', ago(32 * 24 * HOUR), '203.0.113.1'),
    ]);
    const { res, promise } = call();
    await promise;
    expect(flagIds(res)).toEqual(['new_ip_or_device']);
  });
});
