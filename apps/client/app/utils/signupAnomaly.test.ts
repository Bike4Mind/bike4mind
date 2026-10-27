import { describe, expect, it } from 'vitest';
import { exceedsSignupBaseline, groupSignupDomains } from './signupAnomaly';

const config = { signupBaseline: 1, apiKeyBaseline: 2, thresholdMultiplier: 2, minimumCount: 3 };
describe('signup anomaly signals', () => {
  it('requires both the minimum count and a strict baseline exceedance', () => {
    expect(exceedsSignupBaseline(2, 0, config)).toBe(false);
    expect(exceedsSignupBaseline(4, 2, config)).toBe(false);
    expect(exceedsSignupBaseline(5, 2, config)).toBe(true);
    expect(exceedsSignupBaseline(5, 2, { ...config, thresholdMultiplier: 3 })).toBe(false);
  });

  it('groups case-insensitive domains, preserving exact selection IDs, key counts and spread', () => {
    const groups = groupSignupDomains(
      [
        { id: 'a', email: 'one@EXAMPLE.test', createdAt: '2026-01-01T00:02:00.000Z' },
        { id: 'b', email: 'two@example.test', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'c', email: 'three@example.test', createdAt: '2026-01-01T00:01:00.000Z' },
        { id: 'd', email: 'four@other.test', createdAt: '2026-01-01T00:03:00.000Z' },
      ],
      [{ userId: 'a' }, { userId: 'a' }, { userId: 'd' }],
      config,
      Date.parse('2026-01-01T00:30:00Z')
    );
    expect(groups[0]).toEqual({
      domain: 'example.test',
      userIds: ['a', 'b', 'c'],
      count: 3,
      firstCreatedAt: '2026-01-01T00:00:00.000Z',
      lastCreatedAt: '2026-01-01T00:02:00.000Z',
      apiKeyCount: 2,
      likelyAutomated: true,
    });
    expect(groups[1]).toMatchObject({ domain: 'other.test', count: 1, apiKeyCount: 1, likelyAutomated: false });
    expect(groupSignupDomains([], [], config)).toEqual([]);
  });

  it('takes the domain after the last @ and ignores a trailing dot', () => {
    const groups = groupSignupDomains(
      [
        { id: 'a', email: 'a@b@evil.test', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'b', email: 'c@evil.test.', createdAt: '2026-01-01T00:01:00.000Z' },
      ],
      [],
      config,
      Date.parse('2026-01-01T00:30:00Z')
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ domain: 'evil.test', userIds: ['a', 'b'] });
  });

  it('groups an email without an @ under (unknown)', () => {
    const groups = groupSignupDomains(
      [{ id: 'a', email: 'not-an-email', createdAt: '2026-01-01T00:00:00.000Z' }],
      [],
      config,
      Date.parse('2026-01-01T00:30:00Z')
    );
    expect(groups[0]).toMatchObject({ domain: '(unknown)', userIds: ['a'] });
  });

  it('does not label old accounts on a popular domain as an hourly automation burst', () => {
    const users = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      email: 'user@example.test',
      createdAt: '2025-01-01T00:00:00Z',
    }));
    expect(groupSignupDomains(users, [], config, Date.parse('2026-01-01T00:30:00Z'))[0]).toMatchObject({
      count: 20,
      likelyAutomated: false,
    });
  });
});
