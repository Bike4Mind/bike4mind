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
  isDeployedStage: () => false,
}));
vi.mock('sst', () => ({ Resource: {} }));

// In-memory stand-in for the fixed-window counters the rate limiter increments.
const cache = vi.hoisted(() => {
  const counts = new Map<string, number>();
  return {
    counts,
    failKeys: new Set<string>(),
    tryIncrement: vi.fn(async (key: string, limit: number) => {
      if (cache.failKeys.has(key)) throw new Error('cache unavailable');
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
  adminSettings: [] as { settingName: string; settingValue: string }[],
}));
vi.mock('@bike4mind/database', () => ({
  Subscriber: { findOne: mocks.findOne, create: mocks.create },
  cacheRepository: { tryIncrementWithinLimitFixedWindow: cache.tryIncrement },
  adminSettingsRepository: {
    findAll: async () => mocks.adminSettings,
    findBySettingNames: async () => mocks.adminSettings,
  },
}));
// otcLimitOf reads the admin settings through a 5-minute per-process cache; drop it between tests.
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    getSettingsMap: (db: Parameters<typeof actual.getSettingsMap>[0]) => actual.getSettingsMap(db, { skipCache: true }),
  };
});
vi.mock('@bike4mind/server-utils/integrations/slack/slack', () => ({ postMessageToSlack: mocks.postMessageToSlack }));
// readNetworkMeta's own capture is covered in server/auth; here only its shape on the stored row matters.
const networkMeta = vi.hoisted(() => ({
  ip: '81.2.69.160',
  userAgent: 'Mozilla/5.0',
  asn: 64500,
  asnOrg: 'Example Hosting',
  country: 'GB',
  isDatacenter: true,
  ja4: null,
  wafAnonIp: true,
  wafBotSignal: false,
}));
vi.mock('@server/auth/networkMeta', () => ({ readNetworkMeta: () => networkMeta }));

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

const storedNetwork = (challengeVerified: true | null = null) => ({
  ipPrefix: '81.2.69.0',
  userAgent: 'Mozilla/5.0',
  asn: 64500,
  asnOrg: 'Example Hosting',
  country: 'GB',
  isDatacenter: true,
  ja4: null,
  wafAnonIp: true,
  wafBotSignal: false,
  challengeVerified,
  capturedAt: expect.any(Date),
});
const storedRow = (source = 'subscribe_page', challengeVerified: true | null = null) => ({
  ...person,
  source,
  signupNetwork: storedNetwork(challengeVerified),
  suspicious: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  cache.counts.clear();
  cache.failKeys.clear();
  mocks.adminSettings.length = 0;
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
    expect(mocks.create).toHaveBeenCalledWith(storedRow('subscribe_page', true));
  });

  it('is a no-op while the policy is inactive, so a signup without a token still lands', async () => {
    const res = await submit(person);

    expect(res._getStatusCode()).toBe(201);
    expect(verify).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalled();
  });
});

describe('/api/subscribers/create - per-IP counters', () => {
  it('refuses the sixth signup from one address within 15 minutes, and keeps other addresses open', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await submit({ ...person, email: `ada${i}@example.com` }))._getStatusCode()).toBe(201);
    }

    const refused = submit({ ...person, email: 'ada5@example.com' });
    await expect(refused).rejects.toBeInstanceOf(TooManyRequestsError);
    expect(mocks.create).toHaveBeenCalledTimes(5);

    expect((await submit({ ...person, email: 'bob@example.com' }, '203.0.113.7'))._getStatusCode()).toBe(201);
  });

  it('sets Retry-After on a refusal', async () => {
    cache.counts.set('rate-limit:81.2.69.160:subscribers-create-short', 5);
    const { req, res } = createMocks({ method: 'POST', body: person, headers: { 'x-real-ip': '81.2.69.160' } });
    Object.assign(req, { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });

    await expect(runMiddleware(req, res)).rejects.toBeInstanceOf(TooManyRequestsError);
    expect(Number(res.getHeader('Retry-After'))).toBeGreaterThan(0);
  });

  it('counts a day-long ceiling as well, so a slow drip is bounded too', async () => {
    cache.counts.set('rate-limit:81.2.69.160:subscribers-create-daily', 10);

    await expect(submit(person)).rejects.toBeInstanceOf(TooManyRequestsError);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('buckets IPv6 sources by /64 so one holder cannot rotate addresses for a fresh budget', async () => {
    cache.counts.set('rate-limit:2a02:c7f:1234:5678::/64:subscribers-create-short', 5);

    await expect(submit(person, '2a02:c7f:1234:5678:aaaa:bbbb:cccc:dddd')).rejects.toBeInstanceOf(TooManyRequestsError);
  });

  it('counts a repeat signup too, since the caller cannot tell it apart from a first one', async () => {
    mocks.findOne.mockResolvedValue({ email: person.email });
    const res = await submit(person);

    expect(res._getStatusCode()).toBe(201);
    expect(cache.counts.get('rate-limit:81.2.69.160:subscribers-create-short')).toBe(1);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('lets an admin lower the short cap but never raise it', async () => {
    mocks.adminSettings.push({ settingName: 'subscriberLimitPerIp', settingValue: '2' });
    expect((await submit({ ...person, email: 'ada0@example.com' }))._getStatusCode()).toBe(201);
    expect((await submit({ ...person, email: 'ada1@example.com' }))._getStatusCode()).toBe(201);
    await expect(submit({ ...person, email: 'ada2@example.com' })).rejects.toBeInstanceOf(TooManyRequestsError);

    mocks.adminSettings.splice(0, 1, { settingName: 'subscriberLimitPerIp', settingValue: '50' });
    cache.counts.clear();
    for (let i = 0; i < 5; i++) {
      expect((await submit({ ...person, email: `bob${i}@example.com` }))._getStatusCode()).toBe(201);
    }
    await expect(submit({ ...person, email: 'bob5@example.com' })).rejects.toBeInstanceOf(TooManyRequestsError);
  });
});

describe('/api/subscribers/create - stored row', () => {
  it('trims the names and lower-cases the email before the duplicate check and the insert', async () => {
    await submit({ firstName: '  Ada ', lastName: ' Lovelace  ', email: '  Ada@Example.COM ' });

    expect(mocks.findOne).toHaveBeenCalledWith({ email: 'ada@example.com', deletedAt: null });
    expect(mocks.create).toHaveBeenCalledWith(storedRow());
  });

  it('answers the same ack when the insert hits the unique email index', async () => {
    mocks.create.mockRejectedValue(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
    const res = await submit(person);

    expect(res._getStatusCode()).toBe(201);
    expect(res._getJSONData()).toEqual({ message: 'Thanks -- you are on the list.' });
    expect(mocks.postMessageToSlack).not.toHaveBeenCalled();
  });

  it('still surfaces any other insert failure', async () => {
    mocks.create.mockRejectedValue(new Error('connection lost'));

    await expect(submit(person)).rejects.toThrow('connection lost');
  });
});

describe('/api/subscribers/create - Slack alert cap', () => {
  const signupFrom = (i: number) => submit({ ...person, email: `person${i}@example.com` }, `93.184.216.${i}`);

  it('posts the first ten alerts in an hour, one pause notice on the eleventh, then nothing', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await signupFrom(i))._getStatusCode()).toBe(201);
    }
    expect(mocks.postMessageToSlack).toHaveBeenCalledTimes(10);
    expect(mocks.postMessageToSlack.mock.calls[9][0]).toContain('New Subscriber Alert');

    expect((await signupFrom(10))._getStatusCode()).toBe(201);
    expect(mocks.postMessageToSlack).toHaveBeenCalledTimes(11);
    expect(mocks.postMessageToSlack.mock.calls[10][0]).toContain('alerts are paused until');

    expect((await signupFrom(11))._getStatusCode()).toBe(201);
    expect(mocks.postMessageToSlack).toHaveBeenCalledTimes(11);
    expect(mocks.create).toHaveBeenCalledTimes(12);
  });

  it('keeps the signup when reserving an alert slot fails', async () => {
    cache.failKeys.add('subscriber-limit:slack-alerts');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await submit(person);

    expect(res._getStatusCode()).toBe(201);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
});

describe('/api/subscribers/create - signup source', () => {
  it('defaults a plain waitlist signup to subscribe_page and keeps the alert unchanged', async () => {
    const res = await submit(person);

    expect(res._getStatusCode()).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(storedRow());
    expect(mocks.postMessageToSlack.mock.calls[0][0]).not.toContain('registration was closed');
  });

  it('stores a closed-signup source and flags it in the admin alert', async () => {
    await submit({ ...person, source: 'oauth_signup_closed' });

    expect(mocks.create).toHaveBeenCalledWith(storedRow('oauth_signup_closed'));
    expect(mocks.postMessageToSlack.mock.calls[0][0]).toContain('registration was closed');
    expect(mocks.postMessageToSlack.mock.calls[0][0]).toContain('oauth_signup_closed');
  });

  it('escapes subscriber-supplied names and email in the admin alert', async () => {
    // Real markup is flagged and never reaches Slack (see 'payload-looking names'); this is the
    // escaping that still guards a name the flag lets through.
    await submit({ firstName: 'Ada<3>', lastName: 'A&B', email: 'x@example.com' });

    const text = mocks.postMessageToSlack.mock.calls[0][0] as string;
    expect(text).toContain('Ada&lt;3&gt; A&amp;B');
  });

  it('breaks bare broadcast words in names so they cannot page the channel', async () => {
    await submit({ firstName: 'Ada @channel', lastName: 'hi @here', email: 'x@example.com' });

    const text = mocks.postMessageToSlack.mock.calls[0][0] as string;
    expect(text).toContain('Ada @\u200Bchannel hi @\u200Bhere');
    expect(text).not.toMatch(/@(channel|here)\b/);
  });

  it('breaks links and domains in names so Slack does not auto-link them', async () => {
    await submit({ firstName: 'https://evil.example', lastName: 'go evil.com', email: 'x@example.com' });

    const text = mocks.postMessageToSlack.mock.calls[0][0] as string;
    expect(text).toContain('https:\u200B//evil.\u200Bexample go evil.\u200Bcom');
    expect(text).not.toContain('evil.com');
    expect(text).not.toContain('https://');
  });

  it('leaves the subscriber email intact in the alert', async () => {
    await submit({ ...person, email: 'ada.l@example.com' });

    expect(mocks.postMessageToSlack.mock.calls[0][0]).toContain('(ada.l@example.com)');
  });

  it('rejects a source outside the known set rather than storing caller-chosen text', async () => {
    await expect(submit({ ...person, source: 'anything-goes' })).rejects.toBeInstanceOf(ZodError);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('/api/subscribers/create - payload-looking names', () => {
  it.each([
    ['markup', { firstName: '<img src=x onerror=alert(1)>', lastName: 'Probe' }, ['markup']],
    ['a closing tag', { firstName: 'Ada', lastName: 'x</b>' }, ['markup']],
    ['a formula prefix', { firstName: '=HYPERLINK("http://x")', lastName: '+1' }, ['formula_prefix']],
    ['an at-sign lead', { firstName: '@SUM(A1)', lastName: 'Lovelace' }, ['formula_prefix']],
    ['a minus lead', { firstName: 'Ada', lastName: '-2+3' }, ['formula_prefix']],
    ['a control character', { firstName: 'Ada\u0007', lastName: 'Lovelace' }, ['control_characters']],
    [
      'several at once',
      { firstName: '=<b>x</b>', lastName: 'a\u0000b' },
      ['markup', 'formula_prefix', 'control_characters'],
    ],
  ])('stores %s with its reasons, answers the uniform ack and skips Slack', async (_label, names, reasons) => {
    const res = await submit({ ...person, ...names });

    expect(res._getStatusCode()).toBe(201);
    expect(res._getJSONData()).toEqual({ message: 'Thanks -- you are on the list.' });
    const stored = mocks.create.mock.calls[0][0] as { suspicious: { reasons: string[] } };
    expect(stored).toMatchObject({ ...names, signupNetwork: storedNetwork() });
    expect(stored.suspicious.reasons.sort()).toEqual([...reasons].sort());
    expect(mocks.postMessageToSlack).not.toHaveBeenCalled();
    // A flagged row does not spend a slot of the hourly alert budget either.
    expect(cache.counts.has('subscriber-limit:slack-alerts')).toBe(false);
  });

  it.each(["O'Brien", 'Jean-Luc', 'Anne-Marie', 'Zoe 2nd', 'x > y'])(
    'does not flag the ordinary name %s',
    async name => {
      await submit({ ...person, firstName: name });

      expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ firstName: name, suspicious: null }));
      expect(mocks.postMessageToSlack).toHaveBeenCalledOnce();
    }
  );
});
