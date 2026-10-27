import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ users: vi.fn(), keys: vi.fn(), settings: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  User: { find: mocks.users },
  UserApiKey: { find: mocks.keys },
  adminSettingsRepository: { getSettingsValue: mocks.settings },
}));
import { getDomainGroups, getSignupAnomalySnapshot, KEY_SCAN_LIMIT, SIGNUP_SCAN_LIMIT } from './signupAnomaly';

function query(rows: unknown[]) {
  const chain = {
    select: vi.fn(),
    hint: vi.fn(),
    sort: vi.fn(),
    limit: vi.fn(),
    maxTimeMS: vi.fn(),
    lean: vi.fn().mockResolvedValue(rows),
  };
  for (const method of [chain.select, chain.hint, chain.sort, chain.limit, chain.maxTimeMS])
    method.mockReturnValue(chain);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockResolvedValue({ signupBaseline: 1, apiKeyBaseline: 1, thresholdMultiplier: 2, minimumCount: 3 });
});

describe('bounded signup reads', () => {
  it('uses indexed hour ranges, row caps and execution deadlines', async () => {
    const users = query([{ _id: 'a', email: 'a@example.test', createdAt: new Date('2026-01-01T00:30:00Z') }]);
    const keys = query([{ userId: 'a' }, { userId: 'a' }, { userId: 'a' }]);
    mocks.users.mockReturnValue(users);
    mocks.keys.mockReturnValue(keys);
    const snapshot = await getSignupAnomalySnapshot(new Date('2026-01-01T01:00:00Z'));
    expect(mocks.users).toHaveBeenCalledWith({
      createdAt: { $gte: new Date('2026-01-01T00:00:00Z'), $lt: new Date('2026-01-01T01:00:00Z') },
    });
    expect(users.hint).toHaveBeenCalledWith({ createdAt: 1 });
    expect(keys.hint).toHaveBeenCalledWith({ createdAt: 1 });
    expect(users.limit).toHaveBeenCalledWith(SIGNUP_SCAN_LIMIT + 1);
    expect(keys.limit).toHaveBeenCalledWith(KEY_SCAN_LIMIT + 1);
    expect(users.maxTimeMS).toHaveBeenCalledWith(2000);
    expect(snapshot).toMatchObject({
      signupCount: 1,
      apiKeyCount: 3,
      signupSpike: false,
      apiKeySpike: true,
      topDomain: 'example.test',
      truncated: false,
    });
  });

  it('labels over-cap counts partial, never exact', async () => {
    mocks.users.mockReturnValue(
      query(
        Array.from({ length: SIGNUP_SCAN_LIMIT + 1 }, (_, i) => ({
          _id: String(i),
          email: 'a@example.test',
          createdAt: new Date(),
        }))
      )
    );
    mocks.keys.mockReturnValue(query([]));
    expect(await getSignupAnomalySnapshot()).toMatchObject({ truncated: true, signupCount: SIGNUP_SCAN_LIMIT });
  });

  it('only reads keys belonging to the bounded cohort and flags capped counts', async () => {
    const keys = query(Array.from({ length: KEY_SCAN_LIMIT + 1 }, () => ({ userId: 'a' })));
    mocks.keys.mockReturnValue(keys);
    const result = await getDomainGroups([{ _id: 'a', email: 'a@example.test', createdAt: new Date() }]);
    expect(mocks.keys).toHaveBeenCalledWith({ userId: { $in: ['a'] } });
    expect(keys.hint).toHaveBeenCalledWith({ userId: 1, status: 1 });
    expect(result.keysTruncated).toBe(true);
    expect(result.groups[0].apiKeyCount).toBe(KEY_SCAN_LIMIT);
  });
});
