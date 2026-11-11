import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { RequestHandler } from 'express';

const h = vi.hoisted(() => ({
  limiters: [] as RequestHandler[],
  tryIncrement: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    use: (fn: RequestHandler) => {
      h.limiters.push(fn);
      return chain;
    },
    get: () => chain,
    post: () => chain,
  };
  return { baseApi: () => chain };
});
vi.mock('@bike4mind/database', () => ({
  FeedbackModel: {},
  FeedbackTextModel: {},
  adminSettingsRepository: {},
  cacheRepository: { tryIncrementWithinLimitFixedWindow: h.tryIncrement },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<object>()),
  getSettingsMap: vi.fn(),
  getSettingsValue: vi.fn(),
}));
vi.mock('@server/utils/feedbackReadAudit', () => ({ recordFeedbackRead: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@bike4mind/server-utils/integrations/slack/slack', () => ({ postFeedbackToSlack: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({ EmailEvents: { Send: { publish: vi.fn() } } }));

await import('../index');

const run = async (limiter: RequestHandler, method: string, user?: { id: string }) => {
  const { req, res } = createMocks({ method: method as 'POST', headers: { 'x-forwarded-for': '203.0.113.9' } });
  Object.assign(req, { user });
  const next = vi.fn();
  await limiter(req, res, next);
  return { res, next };
};

describe('POST /api/feedback rate limits', () => {
  beforeEach(() => {
    h.tryIncrement.mockReset();
  });

  it('registers a per-IP and a per-user limiter', () => {
    expect(h.limiters).toHaveLength(2);
  });

  it.each([0, 1])('limiter %i passes the request on while under its limit', async index => {
    h.tryIncrement.mockResolvedValue({ success: true, expiresAt: new Date(Date.now() + 60_000) });
    const { next } = await run(h.limiters[index], 'POST', { id: 'u1' });
    expect(next).toHaveBeenCalledWith();
  });

  it.each([0, 1])('limiter %i answers 429 with Retry-After once its limit is used', async index => {
    h.tryIncrement.mockResolvedValue({ success: false, expiresAt: new Date(Date.now() + 90_000) });
    const { res, next } = await run(h.limiters[index], 'POST', { id: 'u1' });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 429 }));
    expect(Number(res.getHeader('Retry-After'))).toBeGreaterThan(0);
  });

  it.each([0, 1])('limiter %i leaves other methods uncounted', async index => {
    const { next } = await run(h.limiters[index], 'GET');
    expect(next).toHaveBeenCalledWith();
    expect(h.tryIncrement).not.toHaveBeenCalled();
  });
});
