// @vitest-environment node
/**
 * PUT/GET/DELETE [id]/grants and GET shared through the real `baseApi` chain and error handler. The access rules are
 * in packages/server-utils/src/callableFunctions/sharing.e2e.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';
import type { NextApiRequest, NextApiResponse } from 'next';
import { BadRequestError, ConflictError, NotFoundError } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  enabled: true,
  perUserBuckets: [] as string[],
  shareCallableFunction: vi.fn(),
  getCallableFunctionShare: vi.fn(),
  revokeCallableFunctionShare: vi.fn(),
  listSharedCallableFunctions: vi.fn(),
}));

vi.mock('@bike4mind/server-utils/callableFunctions/sharing', () => ({
  shareCallableFunction: h.shareCallableFunction,
  getCallableFunctionShare: h.getCallableFunctionShare,
  revokeCallableFunctionShare: h.revokeCallableFunctionShare,
  listSharedCallableFunctions: h.listSharedCallableFunctions,
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

import grantsRoute from '../[id]/grants';
import sharedRoute from '../shared';

const FUNCTION_ID = '6650f0a1b2c3d4e5f6a7b8c9';
const PERSON = '6650f0a1b2c3d4e5f6a7b8d0';
type Route = (req: unknown, res: unknown) => Promise<unknown>;

async function fire(route: unknown, { method = 'PUT', body = {} as unknown } = {}) {
  const { req, res } = createMocks<NextApiRequest, NextApiResponse>(
    {
      method: method as 'PUT',
      url: `/api/callable-functions/${FUNCTION_ID}/grants`,
      query: { id: FUNCTION_ID },
      body: body as never,
      headers: { 'content-type': 'application/json', authorization: 'Bearer live-jwt' },
    },
    { eventEmitter: EventEmitter }
  );
  await (route as Route)(req, res);
  return res;
}

const SHARE = { visibility: 'organization', organizationId: 'org-1', userIds: [PERSON] };

beforeEach(() => {
  h.enabled = true;
  for (const mock of [
    h.shareCallableFunction,
    h.getCallableFunctionShare,
    h.revokeCallableFunctionShare,
    h.listSharedCallableFunctions,
  ]) {
    mock.mockReset();
  }
  h.shareCallableFunction.mockResolvedValue({ id: FUNCTION_ID, grants: SHARE });
  h.revokeCallableFunctionShare.mockResolvedValue({ id: FUNCTION_ID, grants: null });
  h.getCallableFunctionShare.mockResolvedValue({ grants: SHARE, people: [{ id: PERSON, name: 'Person' }] });
  h.listSharedCallableFunctions.mockResolvedValue([]);
});

it('gives each route its own per-user rate limit bucket', () => {
  expect(h.perUserBuckets).toEqual(
    expect.arrayContaining([
      'GET /api/callable-functions/[id]/grants',
      'PUT /api/callable-functions/[id]/grants',
      'DELETE /api/callable-functions/[id]/grants',
      'GET /api/callable-functions/shared',
    ])
  );
});

describe('PUT [id]/grants', () => {
  it('passes the share to the service as the signed-in owner', async () => {
    const res = await fire(grantsRoute, { body: SHARE });
    expect(res._getStatusCode()).toBe(200);
    expect(h.shareCallableFunction).toHaveBeenCalledWith(JWT_USER, FUNCTION_ID, SHARE);
  });

  it('takes 50 people and refuses 51', async () => {
    const people = (n: number) =>
      Array.from({ length: n }, (_, i) => `6650f0a1b2c3d4e5f6a7${String(i).padStart(4, '0')}`);
    expect((await fire(grantsRoute, { body: { visibility: 'private', userIds: people(50) } }))._getStatusCode()).toBe(
      200
    );
    const res = await fire(grantsRoute, { body: { visibility: 'private', userIds: people(51) } });
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toMatchObject({ code: 'invalid_body' });
    expect(h.shareCallableFunction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a public rung', { ...SHARE, visibility: 'public' }],
    ['no people list', { visibility: 'private' }],
    ['the state', { ...SHARE, state: 'live' }],
    ['the pin', { ...SHARE, pin: { source: 'def run(): pass' } }],
    ['the owner', { ...SHARE, ownerKey: 'someone-else' }],
    ['a share token', { ...SHARE, token: 'abc' }],
  ])('refuses a body with %s', async (_name, body) => {
    const res = await fire(grantsRoute, { body });
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toMatchObject({ code: 'invalid_body' });
    expect(h.shareCallableFunction).not.toHaveBeenCalled();
  });

  it.each([
    ["404 for a tool that is not the caller's", new NotFoundError('Tool not found'), 404, undefined],
    [
      '409 for a tool that is not live',
      new ConflictError('Promote the tool before sharing it.', { code: 'not_live' }),
      409,
      'not_live',
    ],
    [
      '400 with the code for a share naming nobody',
      new BadRequestError('Name at least one person.', { code: 'no_recipients' }),
      400,
      'no_recipients',
    ],
  ])('answers %s', async (_name, failure, status, code) => {
    h.shareCallableFunction.mockRejectedValue(failure);
    const res = await fire(grantsRoute, { body: SHARE });
    expect(res._getStatusCode()).toBe(status);
    if (code) expect(res._getJSONData()).toMatchObject({ code });
  });

  it('is 403 with the setting off', async () => {
    h.enabled = false;
    expect((await fire(grantsRoute, { body: SHARE }))._getStatusCode()).toBe(403);
    expect(h.shareCallableFunction).not.toHaveBeenCalled();
  });
});

describe('GET and DELETE [id]/grants', () => {
  it('reads the share and stops sharing, each as the signed-in owner', async () => {
    expect((await fire(grantsRoute, { method: 'GET' }))._getJSONData()).toMatchObject({ grants: SHARE });
    expect(h.getCallableFunctionShare).toHaveBeenCalledWith(JWT_USER, FUNCTION_ID);
    expect((await fire(grantsRoute, { method: 'DELETE' }))._getJSONData()).toMatchObject({ grants: null });
    expect(h.revokeCallableFunctionShare).toHaveBeenCalledWith(JWT_USER, FUNCTION_ID);
  });

  it('is 403 on read with the setting off', async () => {
    h.enabled = false;
    expect((await fire(grantsRoute, { method: 'GET' }))._getStatusCode()).toBe(403);
    expect(h.getCallableFunctionShare).not.toHaveBeenCalled();
  });

  it("answers 404 when the tool is not the caller's", async () => {
    h.getCallableFunctionShare.mockRejectedValue(new NotFoundError('Tool not found'));
    expect((await fire(grantsRoute, { method: 'GET' }))._getStatusCode()).toBe(404);
    h.revokeCallableFunctionShare.mockRejectedValue(new NotFoundError('Tool not found'));
    expect((await fire(grantsRoute, { method: 'DELETE' }))._getStatusCode()).toBe(404);
  });

  it('stops sharing with the setting off, as delete does', async () => {
    h.enabled = false;
    expect((await fire(grantsRoute, { method: 'DELETE' }))._getStatusCode()).toBe(200);
  });
});

describe('GET shared', () => {
  it('lists what is shared with the caller, and nothing with the setting off', async () => {
    h.listSharedCallableFunctions.mockResolvedValue([{ id: FUNCTION_ID, status: 'pending_review' }]);
    expect((await fire(sharedRoute, { method: 'GET' }))._getJSONData()).toEqual([
      { id: FUNCTION_ID, status: 'pending_review' },
    ]);
    h.enabled = false;
    expect((await fire(sharedRoute, { method: 'GET' }))._getJSONData()).toEqual([]);
    expect(h.listSharedCallableFunctions).toHaveBeenCalledTimes(1);
  });
});
