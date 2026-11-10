// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { Request } from 'express';

const h = vi.hoisted(() => ({ rateLimit: vi.fn(() => 'middleware') }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: h.rateLimit }));

import { WAF_QUERY_RATE_LIMIT, isWafDebugRequest, wafQueryRateLimit } from './wafApiHelpers';

const asReq = (user: unknown, debug?: string) => ({ user, query: { debug } }) as unknown as Request;

describe('isWafDebugRequest', () => {
  it.each([
    ['full admin outside production with debug=true', 'staging', { isAdmin: true }, 'true', true],
    ['full admin in production', 'production', { isAdmin: true }, 'true', false],
    ['delegate with a permission', 'staging', { isAdmin: false, adminPermissions: ['support:read'] }, 'true', false],
    ['no user (API key caller)', 'staging', undefined, 'true', false],
    ['debug missing', 'staging', { isAdmin: true }, undefined, false],
    ['debug not the string true', 'staging', { isAdmin: true }, '1', false],
  ])('%s', (_name, stage, user, debug, expected) => {
    expect(isWafDebugRequest(asReq(user, debug), stage)).toBe(expected);
  });
});

describe('wafQueryRateLimit', () => {
  it('buckets per route, per minute, and exempts full admins only', async () => {
    wafQueryRateLimit('waf-traffic');

    const options = h.rateLimit.mock.calls[0][0] as {
      limit: (req: Request) => number;
      windowMs: number;
      bucket: string;
    };
    expect(options.bucket).toBe('waf-traffic');
    expect(options.windowMs).toBe(60_000);
    expect(options.limit(asReq({ isAdmin: true }))).toBe(Infinity);
    expect(options.limit(asReq({ isAdmin: false, adminPermissions: ['support:read'] }))).toBe(WAF_QUERY_RATE_LIMIT);
    expect(options.limit(asReq(undefined))).toBe(WAF_QUERY_RATE_LIMIT);
    expect(WAF_QUERY_RATE_LIMIT).toBe(20);
  });
});
