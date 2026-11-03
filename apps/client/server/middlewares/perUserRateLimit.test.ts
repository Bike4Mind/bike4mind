// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request } from 'express';

const { mockResolve } = vi.hoisted(() => ({ mockResolve: vi.fn() }));

vi.mock('@server/utils/userRateTier', () => ({
  resolveUserRateLimitPerMin: (...a: unknown[]) => mockResolve(...a),
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: vi.fn() }));

import { blockedAtZeroTierLimit } from './perUserRateLimit';

// The resolver only reads the authenticated user from this request fixture.
const req = { user: { id: 'u1' } } as unknown as Request;

describe('blockedAtZeroTierLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 0 (block) when the tier limit is 0', async () => {
    mockResolve.mockResolvedValue(0);
    expect(await blockedAtZeroTierLimit(50)(req)).toBe(0);
    expect(mockResolve).toHaveBeenCalledWith(req.user, req);
  });

  it('blocks when the tier limit is NaN or negative', async () => {
    mockResolve.mockResolvedValue(NaN);
    expect(await blockedAtZeroTierLimit(50)(req)).toBe(0);
    mockResolve.mockResolvedValue(-1);
    expect(await blockedAtZeroTierLimit(50)(req)).toBe(0);
  });

  it.each([10, 100, Infinity])('keeps the route fixed cap when the tier limit is %s', async tier => {
    mockResolve.mockResolvedValue(tier);
    expect(await blockedAtZeroTierLimit(50)(req)).toBe(50);
  });
});
