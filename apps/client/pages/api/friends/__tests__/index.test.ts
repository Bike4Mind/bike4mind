// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  middlewares: [] as unknown[],
  rateLimitOptions: null as unknown,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, unknown> = {
    use: (fn: unknown) => {
      h.middlewares.push(fn);
      return chain;
    },
    post: () => chain,
  };
  return { baseApi: () => chain };
});
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => {
    h.rateLimitOptions = options;
    return 'rate-limit-middleware';
  },
}));
vi.mock('@server/auth/assertOutboundActionAllowed', () => ({ outboundActionGate: () => 'gate' }));
vi.mock('@bike4mind/database', () => ({}));
vi.mock('@bike4mind/services', () => ({ friendshipService: {} }));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));

import '../index';

describe('POST /api/friends', () => {
  it('is rate limited per user on a stable bucket', () => {
    expect(h.middlewares).toContain('rate-limit-middleware');
    expect(h.rateLimitOptions).toMatchObject({ bucket: 'friends-request' });
  });
});
