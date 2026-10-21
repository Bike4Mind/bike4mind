import { describe, it, expect, vi } from 'vitest';

const { rateLimit } = vi.hoisted(() => ({ rateLimit: vi.fn(() => 'rate-limit-middleware') }));

vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit }));
vi.mock('@server/middlewares/baseApi', () => {
  const chain = { use: () => chain, post: () => chain };
  return { baseApi: () => chain };
});
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@bike4mind/server-utils/auth/consentGate', () => ({ hasAcceptedPolicy: vi.fn() }));

describe('POST /api/user/accept-policies/shown rate limit', () => {
  it('allows only a few impressions per user per hour', async () => {
    await import('../shown');
    expect(rateLimit).toHaveBeenCalledWith({
      limit: 5,
      windowMs: 60 * 60 * 1000,
      bucket: '/api/user/accept-policies/shown',
    });
  });
});
