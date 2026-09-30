import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { Request, Response, NextFunction } from 'express';

/**
 * Regression guard for the annotation WRITE surface. POST /api/publish/annotations/[publicId] is an
 * `auth: false` route that admits writers through the shared optionalAuth shim. This test runs the
 * REAL optionalAuth so that if its OAuth/mfaPending default-deny is ever reverted, an OAuth token
 * creating a comment as the subject user fails HERE, not just in the middleware's own unit test.
 * The same optionalAuth backs the sibling [id].ts edit/delete route.
 */

const { mockAuthenticate, mockCreate, mockLoadFindOne } = vi.hoisted(() => ({
  mockAuthenticate: vi.fn(),
  mockCreate: vi.fn(),
  mockLoadFindOne: vi.fn(),
}));

// Run the .use() middlewares in order before the method handler, so the real optionalAuth executes.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const mws: ((req: unknown, res: unknown, next: () => void) => unknown)[] = [];
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain: Record<string, unknown> = Object.assign(
      async (req: { method?: string }, res: unknown) => {
        for (const mw of mws) {
          await new Promise<void>(resolve => {
            void Promise.resolve(mw(req, res, () => resolve()));
          });
        }
        return handlers[req.method ?? 'GET']?.(req, res);
      },
      {
        use: (fn: (req: unknown, res: unknown, next: () => void) => unknown) => (mws.push(fn), chain),
        get: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.GET = fn), chain),
        post: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.POST = fn), chain),
      }
    );
    return chain;
  },
}));

// optionalAuth's own dependencies: passport (raw) and the apiKey shim. The apiKey shim passes
// through when no X-API-Key is present, so the Bearer-JWT branch runs.
vi.mock('passport', () => ({ default: { authenticate: mockAuthenticate } }));
vi.mock('@server/middlewares/apiKeyAuth', () => ({
  apiKeyAuth: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('@bike4mind/database', () => ({
  Annotation: { create: mockCreate, find: vi.fn(), countDocuments: vi.fn(), findOne: vi.fn() },
  PublishedArtifact: { findOne: mockLoadFindOne },
}));
vi.mock('@bike4mind/common', () => ({
  CreateAnnotationRequestSchema: { safeParse: (b: unknown) => ({ success: true, data: b }) },
}));
vi.mock('@server/services/publish', () => ({
  checkVisibility: vi.fn(),
  canAnnotate: vi.fn(),
  toPublishUser: vi.fn(),
  authorDisplayName: vi.fn(),
  toAnnotationDto: vi.fn(),
  requestHasGateProof: vi.fn(),
}));

import handler from '../[publicId]';

const queueAuthResult = (user: unknown) => {
  mockAuthenticate.mockImplementation((_s: string, _o: unknown, cb: (e: unknown, u: unknown) => void) => {
    return (_req: Request, _res: Response, _next: NextFunction) => cb(null, user);
  });
};

const post = () => {
  const { req, res } = createMocks({
    method: 'POST',
    query: { publicId: 'pub1' },
    headers: { authorization: 'Bearer some.token' },
    body: { body: 'hi', anchor: {} },
  });
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  mockAuthenticate.mockReset();
  mockCreate.mockReset();
  mockLoadFindOne.mockReset();
});

describe('POST /api/publish/annotations/[publicId] - OAuth tokens cannot write', () => {
  it('401s a relying-party OAuth access token and creates nothing', async () => {
    queueAuthResult({ id: 'u1', oauthGrant: { scopes: ['openid'], clientId: 'c1' } });
    const { res, promise } = post(undefined);
    await promise;

    expect(res._getStatusCode()).toBe(401);
    expect(mockCreate).not.toHaveBeenCalled();
    // Short-circuits before it ever loads the artifact.
    expect(mockLoadFindOne).not.toHaveBeenCalled();
  });

  it('401s a pre-MFA (mfaPending) session and creates nothing', async () => {
    queueAuthResult({ id: 'u1', mfaPending: true });
    const { res, promise } = post(undefined);
    await promise;

    expect(res._getStatusCode()).toBe(401);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
