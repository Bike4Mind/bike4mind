import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ users: vi.fn(), keys: vi.fn(), exists: vi.fn(), counts: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  User: { find: mocks.users, exists: mocks.exists, aggregate: mocks.counts },
  UserApiKey: { find: mocks.keys },
}));
vi.mock('./signupClassifier', () => ({
  SPIKE_BASELINE_HOURS: 168,
  classifySignups: () => new Map([['user-1', []]]),
}));
import {
  clearCohortCache,
  getSignupVerdicts,
  TIMESERIES_KEY_SCAN_LIMIT,
  TIMESERIES_SCAN_LIMIT,
} from './signupTimeseries';

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

const now = new Date('2026-11-01T12:00:00Z');
const createdAt = new Date(now.getTime() - 60_000);

beforeEach(() => {
  vi.resetAllMocks();
  clearCohortCache();
  mocks.exists.mockReturnValue({ maxTimeMS: vi.fn().mockResolvedValue({ _id: 'user-1' }) });
  mocks.counts.mockReturnValue({
    hint: vi.fn().mockReturnValue({ option: vi.fn().mockResolvedValue([]) }),
  });
});

describe('getSignupVerdicts coverage flags', () => {
  it.each([
    { truncated: false, keysTruncated: false },
    { truncated: true, keysTruncated: false },
    { truncated: false, keysTruncated: true },
    { truncated: true, keysTruncated: true },
  ])('returns truncated=$truncated and keysTruncated=$keysTruncated', async ({ truncated, keysTruncated }) => {
    mocks.users.mockReturnValue(
      query(
        Array.from({ length: truncated ? TIMESERIES_SCAN_LIMIT + 1 : 1 }, () => ({
          _id: 'user-1',
          createdAt,
        }))
      )
    );
    mocks.keys.mockReturnValue(
      query(
        Array.from({ length: keysTruncated ? TIMESERIES_KEY_SCAN_LIMIT + 1 : 0 }, () => ({
          userId: 'user-1',
          createdAt,
        }))
      )
    );

    expect(await getSignupVerdicts({ range: '24h', userIds: ['user-1'] }, now)).toEqual({
      verdicts: { 'user-1': { suspected: false, signals: [] } },
      truncated,
      keysTruncated,
    });
  });

  it('skips the cohort scan when no requested account is in range', async () => {
    mocks.exists.mockReturnValue({ maxTimeMS: vi.fn().mockResolvedValue(null) });

    expect(await getSignupVerdicts({ range: '24h', userIds: ['old-user'] }, now)).toEqual({
      verdicts: { 'old-user': null },
    });
    expect(mocks.users).not.toHaveBeenCalled();
    expect(mocks.keys).not.toHaveBeenCalled();
    expect(mocks.counts).not.toHaveBeenCalled();
  });
});
