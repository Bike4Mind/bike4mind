import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/security/user-summary aggregates failed-login patterns bucketed by IP.
 * The aggregation collects an `emails` array of every user targeted from the same
 * IP; the response must NOT include it (it would leak co-targeted users' emails).
 * Only the caller's own usernames are exposed.
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

import '@pages/api/security/user-summary';

describe('GET /api/security/user-summary - email leak strip', () => {
  beforeEach(() => {
    repo.getUserFailedLogins.mockClear();
    repo.getSuspiciousPatternsTargetingUser.mockClear();
  });

  it("drops the emails array and only exposes the caller's own usernames", async () => {
    const { req, res } = createMocks({ method: 'GET', query: {} });
    (req as any).user = { email: 'me@example.com', username: 'me' };
    await mockRefs.getHandler!(req, res);

    const body = res._getJSONData();
    const pattern = body.suspiciousPatterns.items[0];
    expect('emails' in pattern).toBe(false);
    expect(pattern.usernames).toEqual(['me']); // 'victim' filtered out
    expect(JSON.stringify(body)).not.toContain('victim@example.com');
  });
});
