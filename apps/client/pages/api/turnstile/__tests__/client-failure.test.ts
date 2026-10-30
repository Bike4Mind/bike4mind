import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { NextApiRequest, NextApiResponse } from 'next';

// Middleware is stripped so the handler body runs directly; the rate limiter is recorded so its
// wiring can be asserted on its own.
const wiring = vi.hoisted(() => ({ baseApiOptions: [] as unknown[], rateLimits: [] as unknown[] }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    wiring.baseApiOptions.push(options);
    const chain = {
      use: () => chain,
      post: (fn: unknown) => fn,
    };
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => {
    wiring.rateLimits.push(options);
    return vi.fn();
  },
}));
vi.mock('@bike4mind/server-utils/utils/ip', () => ({ getClientIp: () => '203.0.113.7' }));

import handler from '../client-failure';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

function call(body: unknown) {
  const warn = vi.fn();
  const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: 'POST', body });
  Object.assign(req, { logger: { warn } });
  return { promise: (handler as unknown as Handler)(req, res), res, warn };
}

describe('POST /api/turnstile/client-failure', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is open to signed-out callers and rate limited', () => {
    expect(wiring.baseApiOptions).toEqual([{ auth: false }]);
    expect(wiring.rateLimits).toEqual([{ limit: 20, windowMs: 15 * 60 * 1000 }]);
  });

  it('logs the failure with the caller IP and answers 204', async () => {
    const { promise, res, warn } = call({ action: 'oauth-start', reason: 'error', errorCode: '300030', attempts: 3 });
    await promise;
    expect(res._getStatusCode()).toBe(204);
    expect(warn).toHaveBeenCalledWith('turnstile-client-failure', {
      action: 'oauth-start',
      reason: 'error',
      errorCode: '300030',
      attempts: 3,
      ip: '203.0.113.7',
    });
  });

  it.each([
    ['an unknown action', { action: 'anything', reason: 'error', attempts: 1 }],
    ['an unknown reason', { action: 'otc-send', reason: 'nope', attempts: 1 }],
    [
      'an error code that is not a short code',
      { action: 'otc-send', reason: 'error', errorCode: '<b>x</b>', attempts: 1 },
    ],
    ['an out-of-range attempt count', { action: 'otc-send', reason: 'error', attempts: 0 }],
  ])('rejects %s without logging it', async (_label, body) => {
    const { promise, warn } = call(body);
    await expect(promise).rejects.toThrow('Invalid request body');
    expect(warn).not.toHaveBeenCalled();
  });
});
