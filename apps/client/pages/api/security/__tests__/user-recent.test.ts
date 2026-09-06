import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/security/user-recent surfaces recent suspicious patterns; like
 * user-summary it must drop the IP-bucketed `emails` array so co-targeted users'
 * emails do not leak, exposing only the caller's own usernames.
 */

// `any` below is deliberate test-mock plumbing: typing the full next-connect /
// node-mocks-http chain adds no coverage value (matches the repo's handler-test convention).
const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const repo = vi.hoisted(() => ({
  getUserFailedLogins: vi.fn().mockResolvedValue([]),
  getSuspiciousPatternsTargetingUser: vi.fn().mockResolvedValue([
    {
      ip: '1.2.3.4',
      attempts: 5,
      usernames: ['me', 'victim'],
      emails: ['me@example.com', 'victim@example.com'],
      lastAttempt: new Date('2026-01-01').toISOString(),
      firstAttempt: new Date('2026-01-01').toISOString(),
      riskLevel: 'high',
    },
  ]),
}));
vi.mock('@bike4mind/database', () => ({ authFailLogRepository: repo }));

import '@pages/api/security/user-recent';

describe('GET /api/security/user-recent - email leak strip', () => {
  beforeEach(() => {
    repo.getUserFailedLogins.mockClear();
    repo.getSuspiciousPatternsTargetingUser.mockClear();
  });

  it('drops the emails array from suspicious-pattern items', async () => {
    const { req, res } = createMocks({ method: 'GET', query: {} });
    (req as any).user = { email: 'me@example.com', username: 'me' };
    await mockRefs.getHandler!(req, res);

    const body = res._getJSONData();
    const item = body.items.find((i: any) => i.type === 'suspicious_pattern');
    expect('emails' in item.data).toBe(false);
    expect(item.data.usernames).toEqual(['me']);
    expect(JSON.stringify(body)).not.toContain('victim@example.com');
  });
  // Same NaN-arithmetic shape as user-summary: `hours` reaches a Date-typed `createdAt`
  // filter, and this route has no admin gate either.
  it('rejects a non-numeric hours as a 400 before the repository is queried', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { hours: 'abc' } });
    (req as any).user = { email: 'me@example.com', username: 'me' };

    await expect(mockRefs.getHandler!(req, res)).rejects.toMatchObject({ statusCode: 400 });
    expect(repo.getUserFailedLogins).not.toHaveBeenCalled();
  });

  // A large negative hours is finite, so it survives Number.isNaN, but the arithmetic
  // overflows the Date range. The two-sided clamp is what keeps `since` valid.
  it('clamps a negative hours rather than building an Invalid Date', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { hours: '-99999999999999' } });
    (req as any).user = { email: 'me@example.com', username: 'me' };
    await mockRefs.getHandler!(req, res);

    const since = repo.getUserFailedLogins.mock.calls[0][2] as Date;
    expect(Number.isNaN(since.getTime())).toBe(false);
    expect(since.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('still accepts a numeric hours and passes a valid date window down', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { hours: '48' } });
    (req as any).user = { email: 'me@example.com', username: 'me' };
    await mockRefs.getHandler!(req, res);

    const since = repo.getUserFailedLogins.mock.calls[0][2] as Date;
    expect(Number.isNaN(since.getTime())).toBe(false);
  });
});
