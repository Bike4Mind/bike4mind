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
});
