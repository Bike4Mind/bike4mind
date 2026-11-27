// @vitest-environment node
/**
 * GET [id]/recipient through the real `baseApi` chain and error handler. What the lookup finds is in
 * packages/server-utils/src/callableFunctions/sharing.e2e.test.ts ("naming a person by address").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';
import type { NextApiRequest, NextApiResponse } from 'next';

const h = vi.hoisted(() => ({
  enabled: true,
  limited: false,
  rateLimits: [] as Array<{ limit: unknown; windowMs: number; bucket: string }>,
  findCallableFunctionRecipient: vi.fn(),
}));

vi.mock('@bike4mind/server-utils/callableFunctions/sharing', () => ({
  CALLABLE_FUNCTION_RECIPIENT_RATE_LIMIT: { limit: 20, windowMs: 60_000, bucket: 'callable-functions-recipient' },
  findCallableFunctionRecipient: h.findCallableFunctionRecipient,
}));
vi.mock('@bike4mind/server-utils/callableFunctions/access', async () => {
  const { ForbiddenError } = await import('@bike4mind/common');
  return {
    resolveCallableFunctionsEnabled: vi.fn(async () => h.enabled),
    assertCallableFunctionsEnabled: vi.fn(async () => {
      if (!h.enabled) throw new ForbiddenError('Callable functions are disabled');
    }),
  };
});
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', async () => {
  const { TooManyRequestsError } = await import('@bike4mind/common');
  return {
    rateLimit: (options: { limit: unknown; windowMs: number; bucket: string }) => {
      h.rateLimits.push(options);
      return (_req: unknown, _res: unknown, next: (error?: unknown) => void) =>
        next(h.limited ? new TooManyRequestsError('Rate limit exceeded.') : undefined);
    },
  };
});
vi.mock('@bike4mind/server-utils/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: vi.fn().mockResolvedValue({ allowed: true, headers: {} }),
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@bike4mind/database', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  connectDB: vi.fn().mockResolvedValue(undefined),
}));

const JWT_USER = { id: 'jwt-user', _id: 'jwt-user', isBanned: false, disputePending: false };
vi.mock('@server/auth/auth', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    auth: (
      req: { headers?: Record<string, unknown>; user?: unknown },
      res: { status: (code: number) => { json: (body: unknown) => void } },
      next: () => void
    ) => {
      if (!req.headers?.authorization) return res.status(401).json({ error: 'Unauthorized' });
      if (!req.user) req.user = JWT_USER;
      next();
    },
  };
});

import { NotFoundError } from '@bike4mind/common';
import recipientRoute from '../[id]/recipient';

const FUNCTION_ID = '6650f0a1b2c3d4e5f6a7b8c9';
type Route = (req: unknown, res: unknown) => Promise<unknown>;

async function fire(email: string | string[] = 'person@example.com', method = 'GET') {
  const { req, res } = createMocks<NextApiRequest, NextApiResponse>(
    {
      method: method as 'GET',
      url: `/api/callable-functions/${FUNCTION_ID}/recipient`,
      query: { id: FUNCTION_ID, email },
      headers: { authorization: 'Bearer live-jwt' },
    },
    { eventEmitter: EventEmitter }
  );
  await (recipientRoute as Route)(req, res);
  return res;
}

beforeEach(() => {
  h.enabled = true;
  h.limited = false;
  h.findCallableFunctionRecipient.mockReset().mockResolvedValue({ id: 'u2', name: 'Person Two' });
});

describe('GET [id]/recipient', () => {
  it('has its own per-user bucket, lower than the general address lookup', () => {
    expect(h.rateLimits).toEqual([{ limit: 20, windowMs: 60_000, bucket: 'callable-functions-recipient' }]);
  });

  it('answers the id and name of the account holding the address, for the caller and function named', async () => {
    const res = await fire();
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ id: 'u2', name: 'Person Two' });
    expect(h.findCallableFunctionRecipient).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'jwt-user' }),
      FUNCTION_ID,
      'person@example.com'
    );
  });

  it('answers null, and nothing else, for an address no account holds', async () => {
    h.findCallableFunctionRecipient.mockResolvedValue(null);
    const res = await fire('nobody@example.com');
    expect(res._getStatusCode()).toBe(200);
    expect(res._getData()).toBe('null');
  });

  it('passes an address given twice as none, so no query operator reaches the lookup', async () => {
    h.findCallableFunctionRecipient.mockResolvedValue(null);
    await fire(['a@example.com', 'b@example.com']);
    expect(h.findCallableFunctionRecipient).toHaveBeenCalledWith(expect.anything(), FUNCTION_ID, '');
  });

  it("answers 404 for another person's function", async () => {
    h.findCallableFunctionRecipient.mockRejectedValue(new NotFoundError('Tool not found'));
    const res = await fire();
    expect(res._getStatusCode()).toBe(404);
  });

  it('answers 429 when limited and 403 with callable functions off, without looking the address up', async () => {
    h.limited = true;
    expect((await fire())._getStatusCode()).toBe(429);
    h.limited = false;
    h.enabled = false;
    expect((await fire())._getStatusCode()).toBe(403);
    expect(h.findCallableFunctionRecipient).not.toHaveBeenCalled();
  });

  it('serves GET only', async () => {
    expect((await fire('person@example.com', 'POST'))._getStatusCode()).toBe(404);
    expect(h.findCallableFunctionRecipient).not.toHaveBeenCalled();
  });
});
