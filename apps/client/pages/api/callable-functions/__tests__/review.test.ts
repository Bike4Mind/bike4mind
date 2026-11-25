// @vitest-environment node
/**
 * PUT/PATCH [id]/review through the real `baseApi` chain and error handler. Who may review is in
 * packages/server-utils/src/callableFunctions/sharing.e2e.test.ts ("a recipient review").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';
import type { NextApiRequest, NextApiResponse } from 'next';

const h = vi.hoisted(() => ({
  enabled: true,
  perUserBuckets: [] as string[],
  reviewSharedCallableFunction: vi.fn(),
  updateSharedCallableFunctionReview: vi.fn(),
}));

vi.mock('@bike4mind/server-utils/callableFunctions/reviews', () => ({
  reviewSharedCallableFunction: h.reviewSharedCallableFunction,
  updateSharedCallableFunctionReview: h.updateSharedCallableFunctionReview,
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
vi.mock('@server/middlewares/perUserRateLimit', () => ({
  perUserRateLimit: (bucket: string) => {
    h.perUserBuckets.push(bucket);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
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

import { ConflictError, NotFoundError } from '@bike4mind/common';
import reviewRoute from '../[id]/review';

const FUNCTION_ID = '6650f0a1b2c3d4e5f6a7b8c9';
const HASH = 'c'.repeat(64);
type Route = (req: unknown, res: unknown) => Promise<unknown>;

async function fire({ method = 'PUT', body = {} as unknown } = {}) {
  const { req, res } = createMocks<NextApiRequest, NextApiResponse>(
    {
      method: method as 'PUT',
      url: `/api/callable-functions/${FUNCTION_ID}/review`,
      query: { id: FUNCTION_ID },
      body: body as never,
      headers: { 'content-type': 'application/json', authorization: 'Bearer live-jwt' },
    },
    { eventEmitter: EventEmitter }
  );
  await (reviewRoute as Route)(req, res);
  return res;
}

const REVIEW = { reviewHash: HASH, approval: 'always_ask' };

beforeEach(() => {
  h.enabled = true;
  h.reviewSharedCallableFunction.mockReset().mockResolvedValue({ id: FUNCTION_ID, status: 'reviewed' });
  h.updateSharedCallableFunctionReview.mockReset().mockResolvedValue({ id: FUNCTION_ID, status: 'disabled' });
});

it('gives each method its own per-user rate limit bucket', () => {
  expect(h.perUserBuckets).toEqual(
    expect.arrayContaining(['PUT /api/callable-functions/[id]/review', 'PATCH /api/callable-functions/[id]/review'])
  );
});

describe('PUT [id]/review', () => {
  it('records the review as the signed-in caller', async () => {
    const res = await fire({ body: REVIEW });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ status: 'reviewed' });
    expect(h.reviewSharedCallableFunction).toHaveBeenCalledWith(JWT_USER, FUNCTION_ID, REVIEW);
  });

  it.each([
    ['no hash', { approval: 'default' }],
    ['a malformed hash', { ...REVIEW, reviewHash: 'abc' }],
    ['an unknown approval mode', { ...REVIEW, approval: 'never' }],
    ['the enabled flag', { ...REVIEW, enabled: true }],
    ['a person', { ...REVIEW, userId: 'someone-else' }],
  ])('refuses a body with %s', async (_name, body) => {
    const res = await fire({ body });
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toMatchObject({ code: 'invalid_body' });
    expect(h.reviewSharedCallableFunction).not.toHaveBeenCalled();
  });

  it('answers 404 for a function not shared with the caller and 409 for a changed interface', async () => {
    h.reviewSharedCallableFunction.mockRejectedValueOnce(new NotFoundError('Tool not found'));
    expect((await fire({ body: REVIEW }))._getStatusCode()).toBe(404);
    h.reviewSharedCallableFunction.mockRejectedValueOnce(
      new ConflictError('The tool changed while you were reviewing it. Review it again.', { code: 'review_conflict' })
    );
    const conflict = await fire({ body: REVIEW });
    expect(conflict._getStatusCode()).toBe(409);
    expect(conflict._getJSONData()).toMatchObject({ code: 'review_conflict' });
  });

  it('is 403 with the setting off', async () => {
    h.enabled = false;
    expect((await fire({ body: REVIEW }))._getStatusCode()).toBe(403);
    expect(h.reviewSharedCallableFunction).not.toHaveBeenCalled();
  });
});

describe('PATCH [id]/review', () => {
  it('turns the function off as the signed-in caller, even with the setting off', async () => {
    h.enabled = false;
    const res = await fire({ method: 'PATCH', body: { enabled: false } });
    expect(res._getStatusCode()).toBe(200);
    expect(h.updateSharedCallableFunctionReview).toHaveBeenCalledWith(JWT_USER, FUNCTION_ID, { enabled: false });
  });

  it.each([
    ['nothing to change', {}],
    ['a hash', { reviewHash: HASH, enabled: true }],
    ['a non-boolean enabled', { enabled: 'yes' }],
  ])('refuses a body with %s', async (_name, body) => {
    const res = await fire({ method: 'PATCH', body });
    expect(res._getStatusCode()).toBe(400);
    expect(h.updateSharedCallableFunctionReview).not.toHaveBeenCalled();
  });

  it('answers 404 for a function not shared with the caller', async () => {
    h.updateSharedCallableFunctionReview.mockRejectedValueOnce(new NotFoundError('Tool not found'));
    expect((await fire({ method: 'PATCH', body: { approval: 'default' } }))._getStatusCode()).toBe(404);
  });
});
