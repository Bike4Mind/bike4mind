import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findByTrackingToken: vi.fn(),
    findOrCreate: vi.fn(),
    globalUnsubscribe: vi.fn(),
  },
}));

// Passthrough baseApi exposing .get() and .post(), as in publish/artifact/__tests__/draft-upload.test.ts.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        get: (fn: (req: unknown, res: unknown) => unknown) => ((h.GET = fn), chain),
        post: (fn: (req: unknown, res: unknown) => unknown) => ((h.POST = fn), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@bike4mind/database', () => ({
  emailSendAttemptRepository: { findByTrackingToken: mocks.findByTrackingToken },
  emailPreferencesRepository: { findOrCreate: mocks.findOrCreate, globalUnsubscribe: mocks.globalUnsubscribe },
}));

import handler from '../unsubscribe';

const run = async (
  method: 'GET' | 'POST',
  opts: { headers?: Record<string, string>; query?: Record<string, string> }
) => {
  const { req, res } = createMocks({
    method,
    headers: opts.headers,
    query: opts.query,
    body: { globalUnsubscribe: true },
  });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};

beforeEach(() => {
  mocks.findByTrackingToken.mockReset().mockResolvedValue({ recipientEmail: 'person@example.com' });
  mocks.findOrCreate.mockReset().mockResolvedValue({ unsubscribedCategories: [], globalUnsubscribe: false });
  mocks.globalUnsubscribe.mockReset().mockResolvedValue(undefined);
});

describe('/api/email/unsubscribe', () => {
  it('GET reads the tracking token from the x-unsubscribe-token header', async () => {
    const res = await run('GET', { headers: { 'x-unsubscribe-token': 'tok' } });
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.findByTrackingToken).toHaveBeenCalledWith('tok');
    expect(res._getJSONData().email).toBe('person@example.com');
  });

  it('POST reads the tracking token from the x-unsubscribe-token header', async () => {
    const res = await run('POST', { headers: { 'x-unsubscribe-token': 'tok' } });
    expect(res._getStatusCode()).toBe(200);
    expect(mocks.globalUnsubscribe).toHaveBeenCalledWith('person@example.com');
  });

  it.each(['GET', 'POST'] as const)('%s ignores a ?token= query parameter', async method => {
    await expect(run(method, { query: { token: 'tok' } })).rejects.toMatchObject({ message: 'Token is required' });
    expect(mocks.findByTrackingToken).not.toHaveBeenCalled();
  });
});
