import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ZodError } from 'zod';
import { TooManyRequestsError } from '@bike4mind/utils';

// baseApi is stripped so the handler body runs directly; every middleware passed to .use() is
// recorded and replayed in order by runMiddleware (same pattern as pages/api/otc/__tests__/send.test.ts).
const wiring = vi.hoisted(() => ({ uses: [] as unknown[] }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      use: (mw: unknown) => {
        wiring.uses.push(mw);
        return chain;
      },
      post: (handlerFn: unknown) => handlerFn,
    };
    return chain;
  },
}));
const blockedIp = vi.hoisted(() => vi.fn((_req: unknown, _res: unknown, next: () => void) => next()));
vi.mock('@server/middlewares/checkBlockedIP', () => ({ checkBlockedIP: () => blockedIp }));

// The real requireTurnstile runs against a controllable policy and verifier.
const policy = vi.hoisted(() => ({ active: false }));
const verify = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/auth/turnstile', () => ({
  getTurnstilePolicy: async () => ({ active: policy.active, failClosed: true, siteKey: 'site', secret: 'secret' }),
  turnstileAllowedHostnames: () => ['app.example.com'],
}));
vi.mock('@bike4mind/server-utils/utils/turnstile', () => ({
  verifyTurnstile: verify,
  isTurnstileTestSecret: () => false,
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  isE2EEnabled: () => false,
  isProduction: () => false,
  isDevelopment: () => true,
}));
vi.mock('sst', () => ({ Resource: {} }));

// In-memory stand-in for the fixed-window counters the rate limiter increments.
const cache = vi.hoisted(() => {
  const counts = new Map<string, number>();
  return {
    counts,
    tryIncrement: vi.fn(async (key: string, limit: number) => {
      const count = counts.get(key) ?? 0;
      const expiresAt = new Date(Date.now() + 60_000);
      if (count + 1 > limit) return { success: false, count, expiresAt };
      counts.set(key, count + 1);
      return { success: true, count: count + 1, expiresAt };
    }),
  };
});
const mocks = vi.hoisted(() => ({
  findOne: vi.fn(),
  create: vi.fn(),
  postMessageToSlack: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  Subscriber: { findOne: mocks.findOne, create: mocks.create },
  cacheRepository: { tryIncrementWithinLimitFixedWindow: cache.tryIncrement },
  adminSettingsRepository: { findAll: async () => [], findBySettingNames: async () => [] },
}));
vi.mock('@server/integrations/slack/slack', () => ({ postMessageToSlack: mocks.postMessageToSlack }));

import handler from '@pages/api/subscribers/create';

type Middleware = (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown;

// Runs every recorded middleware in order, as baseApi would before the route handler. A middleware
// that answers the request itself never calls next, so the chain stops there.
async function runMiddleware(req: unknown, res: unknown): Promise<'handled' | 'next'> {
  for (const mw of wiring.uses as Middleware[]) {
    const outcome = await new Promise<'handled' | 'next'>((resolve, reject) => {
      Promise.resolve(mw(req, res, (err?: unknown) => (err ? reject(err) : resolve('next')))).then(
        () => resolve('handled'),
        reject
      );
    });
    if (outcome === 'handled') return 'handled';
  }
  return 'next';
}

const submit = async (body: Record<string, unknown>, ip = '81.2.69.160') => {
  const { req, res } = createMocks({ method: 'POST', body, headers: { 'x-real-ip': ip } });
  Object.assign(req, { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, requestId: 'r1' });
  if ((await runMiddleware(req, res)) === 'next') {
    await handler(req as unknown as Parameters<typeof handler>[0], res as unknown as Parameters<typeof handler>[1]);
  }
  return res;
};

const person = { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' };

beforeEach(() => {
  vi.clearAllMocks();
  cache.counts.clear();
  policy.active = false;
  verify.mockImplementation(async ({ token }: { token: unknown }) =>
    token === 'solved' ? { ok: true } : { ok: false, reason: 'invalid', errorCodes: ['invalid-input-response'] }
  );
  mocks.findOne.mockResolvedValue(null);
  mocks.create.mockResolvedValue({});
});

describe('/api/subscribers/create - bot challenge', () => {
  it('runs the blocked-IP check, the challenge and both per-IP counters ahead of the handler', async () => {
    expect(wiring.uses).toHaveLength(4);
    expect(wiring.uses[0]).toBe(blockedIp);

    // Challenge before counters: a refused request must not consume any rate-limit budget.
    policy.active = true;
    const res = await submit(person);
    expect(res._getStatusCode()).toBe(403);
    expect(blockedIp).toHaveBeenCalledTimes(1);
    expect(cache.tryIncrement).not.toHaveBeenCalled();
  });

  it('refuses a signup without a solved challenge while the policy is active', async () => {
    policy.active = true;
    const res = await submit(person);

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData()).toMatchObject({ code: 'challenge_failed' });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.postMessageToSlack).not.toHaveBeenCalled();
  });

  it('verifies the token against the subscribe action and then stores the signup', async () => {
    policy.active = true;
    const res = await submit({ ...person, turnstileToken: 'solved' });

    expect(res._getStatusCode()).toBe(201);
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ token: 'solved', expectedAction: 'subscribe' }));
    expect(mocks.create).toHaveBeenCalledWith({ ...person, source: 'subscribe_page' });
  });

  it('is a no-op while the policy is inactive, so a signup without a token still lands', async () => {
    const res = await submit(person);

    expect(res._getStatusCode()).toBe(201);
    expect(verify).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalled();
  });
});

describe('/api/subscribers/create - per-IP counters', () => {
  it('refuses the eleventh signup from one address within the hour, and keeps other addresses open', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await submit({ ...person, email: `ada${i}@example.com` }))._getStatusCode()).toBe(201);
    }

    const refused = submit({ ...person, email: 'ada10@example.com' });
    await expect(refused).rejects.toBeInstanceOf(TooManyRequestsError);
    expect(mocks.create).toHaveBeenCalledTimes(10);

    expect((await submit({ ...person, email: 'bob@example.com' }, '203.0.113.7'))._getStatusCode()).toBe(201);
  });

  it('sets Retry-After on a refusal', async () => {
    cache.counts.set('rate-limit:81.2.69.160:subscribers-create-hourly', 10);
    const { req, res } = createMocks({ method: 'POST', body: person, headers: { 'x-real-ip': '81.2.69.160' } });
    Object.assign(req, { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });

    await expect(runMiddleware(req, res)).rejects.toBeInstanceOf(TooManyRequestsError);
    expect(Number(res.getHeader('Retry-After'))).toBeGreaterThan(0);
  });

  it('counts a day-long ceiling as well, so a slow drip is bounded too', async () => {
    cache.counts.set('rate-limit:81.2.69.160:subscribers-create-daily', 30);

    await expect(submit(person)).rejects.toBeInstanceOf(TooManyRequestsError);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('buckets IPv6 sources by /64 so one holder cannot rotate addresses for a fresh budget', async () => {
    cache.counts.set('rate-limit:2a02:c7f:1234:5678::/64:subscribers-create-hourly', 10);

    await expect(submit(person, '2a02:c7f:1234:5678:aaaa:bbbb:cccc:dddd')).rejects.toBeInstanceOf(TooManyRequestsError);
  });

  it('counts a repeat signup too, since the caller cannot tell it apart from a first one', async () => {
    mocks.findOne.mockResolvedValue({ email: person.email });
    const res = await submit(person);

    expect(res._getStatusCode()).toBe(201);
    expect(cache.counts.get('rate-limit:81.2.69.160:subscribers-create-hourly')).toBe(1);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('/api/subscribers/create - signup source', () => {
  it('defaults a plain waitlist signup to subscribe_page and keeps the alert unchanged', async () => {
    const res = await submit(person);

    expect(res._getStatusCode()).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith({ ...person, source: 'subscribe_page' });
    expect(mocks.postMessageToSlack.mock.calls[0][0]).not.toContain('registration was closed');
  });

  it('stores a closed-signup source and flags it in the admin alert', async () => {
    await submit({ ...person, source: 'oauth_signup_closed' });

    expect(mocks.create).toHaveBeenCalledWith({ ...person, source: 'oauth_signup_closed' });
    expect(mocks.postMessageToSlack.mock.calls[0][0]).toContain('registration was closed');
    expect(mocks.postMessageToSlack.mock.calls[0][0]).toContain('oauth_signup_closed');
  });

  it('escapes subscriber-supplied names and email in the admin alert', async () => {
    await submit({ firstName: '<!channel>', lastName: 'A&B', email: 'x@example.com' });

    const text = mocks.postMessageToSlack.mock.calls[0][0] as string;
    expect(text).toContain('&lt;!channel&gt; A&amp;B');
    expect(text).not.toContain('<!channel>');
  });

  it('rejects a source outside the known set rather than storing caller-chosen text', async () => {
    await expect(submit({ ...person, source: 'anything-goes' })).rejects.toBeInstanceOf(ZodError);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
