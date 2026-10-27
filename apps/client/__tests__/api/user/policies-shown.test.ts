// @vitest-environment node
import type { Request, Response } from 'express';
import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  baseApi: vi.fn(),
  rateLimit: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    mocks.baseApi(options);
    return {
      use: () => ({ post: (handler: (req: Request, res: Response) => Promise<unknown>) => handler }),
    };
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: mocks.rateLimit }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: mocks.logEvent }));

import handler from '../../../pages/api/user/accept-policies/shown';

const makeRequest = (body: unknown = {}, aupAcceptedVersion?: string) => {
  const request = createMocks<Request, Response>({ method: 'POST', body });
  request.req.body = body;
  request.req.user = { id: 'user-1', aupAcceptedVersion } as Request['user'];
  return request;
};

describe('POST /api/user/accept-policies/shown', () => {
  beforeEach(() => {
    mocks.logEvent.mockReset();
    mocks.logEvent.mockResolvedValue(undefined);
  });

  it('requires a first-party JWT, only permits POST, and bounds pre-consent writes', () => {
    expect(mocks.baseApi).toHaveBeenCalledWith({ auth: 'jwtOnly', allowedMethods: ['POST'] });
    expect(mocks.rateLimit).toHaveBeenCalledWith({
      limit: 5,
      windowMs: 60 * 60 * 1000,
      bucket: '/api/user/accept-policies/shown',
    });
  });

  it('records the fixed event for an authenticated user who has not accepted policies', async () => {
    const { req, res } = makeRequest();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(204);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      { type: 'policies_shown', userId: 'user-1', metadata: { path: 'interstitial' } },
      { ability: undefined }
    );
  });

  it('does not record the impression for a user who already accepted policies', async () => {
    const { req, res } = makeRequest({}, '2026-01-01');
    await handler(req, res);
    expect(res._getStatusCode()).toBe(204);
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request', async () => {
    const { req, res } = createMocks<Request, Response>({ method: 'POST', body: {} });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(401);
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'credits_granted' },
    { userId: 'another-user' },
    { metadata: { path: 'registration' } },
    { counterValue: 100 },
    null,
    [],
  ])('rejects unrelated client-controlled event data: %j', async body => {
    const { req, res } = makeRequest(body);
    await expect(handler(req, res)).rejects.toMatchObject({ name: 'ZodError' });
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it('propagates a failed event write so it cannot report false success', async () => {
    mocks.logEvent.mockRejectedValue(new Error('Database unavailable'));
    const { req, res } = makeRequest();
    await expect(handler(req, res)).rejects.toThrow('Database unavailable');
  });
});
