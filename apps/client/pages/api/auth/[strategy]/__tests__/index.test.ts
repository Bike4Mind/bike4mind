import { describe, it, expect, vi } from 'vitest';

// Record the middleware chain instead of running it: this file pins which guards sit in front of
// the provider redirect, not what passport does once it gets there.
const chainUses = vi.hoisted((): unknown[] => []);
vi.mock('@server/middlewares/baseApi', () => {
  type Chain = { use: (mw: unknown) => Chain; get: (fn: unknown) => unknown };
  const chain: Chain = {
    use: (mw: unknown) => {
      chainUses.push(mw);
      return chain;
    },
    get: (fn: unknown) => fn,
  };
  return { baseApi: () => chain };
});

const blockedIpGuard = vi.hoisted(() => ({ kind: 'checkBlockedIP' }));
vi.mock('@server/middlewares/checkBlockedIP', () => ({ checkBlockedIP: () => blockedIpGuard }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => ({ kind: 'rateLimit', options }),
}));
vi.mock('@server/auth/auth', () => ({ default: { authenticate: vi.fn() } }));
vi.mock('@bike4mind/server-utils/auth/oauthFlowCookie', () => ({ issueStateNonce: vi.fn() }));
vi.mock('@server/auth/passportOAuthStateStore', () => ({ OAUTH_NONCE_HASH_REQ_KEY: 'nonceHash' }));

import '@pages/api/auth/[strategy]/index';

describe('[strategy] OAuth initiation guards', () => {
  it('refuses blocked IPs before the provider redirect', () => {
    expect(chainUses).toContain(blockedIpGuard);
  });

  it('rate limits per client IP in one bucket shared by every provider', () => {
    expect(chainUses).toContainEqual({
      kind: 'rateLimit',
      options: { limit: 10, windowMs: 60 * 1000, bucket: 'oauth-start' },
    });
  });
});
