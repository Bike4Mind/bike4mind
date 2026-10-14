import { describe, it, expect, vi, beforeEach } from 'vitest';

type Next = (error?: unknown) => void;
type Middleware = (req: unknown, res: unknown, next: Next) => unknown;
type RouteHandler = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  rateLimitSpy: vi.fn(),
  findBySid: vi.fn(),
  routeHandler: vi.fn(),
}));

// Runs the middleware chain in mount order, like next-connect, so the order is observable.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const middlewares: Middleware[] = [];
    const chain = {
      use: (middleware: Middleware) => {
        middlewares.push(middleware);
        return chain;
      },
      post: (routeHandler: RouteHandler) => async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) {
          const error = await new Promise<unknown>(resolve => {
            Promise.resolve(middleware(req, res, (nextError?: unknown) => resolve(nextError))).catch(resolve);
          });
          if (error) return { error };
        }
        await routeHandler(req, res);
        return { error: undefined };
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: () => h.routeHandler }));
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: Next) => {
    h.rateLimitSpy();
    next();
  },
}));
vi.mock('@bike4mind/database', () => ({
  authSessionRepository: { findBySid: h.findBySid },
  passkeyCredentialRepository: {},
  userRepository: {},
}));
vi.mock('@bike4mind/services', () => ({ mfaService: {} }));

import regenerateBackupCodes from '@pages/api/auth/mfa/regenerate-backup-codes';
import mfaSetup from '@pages/api/auth/mfa/setup';

type RunRoute = (req: unknown, res: unknown) => Promise<{ error?: unknown }>;

const requestFor = (user: Record<string, unknown>) => ({ user: { id: 'user-1', sid: 'sid-1', ...user } });

const sessionSteppedUpAt = (stepUpAt: Date | null) => ({
  sid: 'sid-1',
  userId: 'user-1',
  revokedAt: null,
  expiresAt: new Date(Date.now() + 86_400_000),
  stepUpAt,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each([
  ['POST /api/auth/mfa/regenerate-backup-codes', regenerateBackupCodes as unknown as RunRoute],
  ['POST /api/auth/mfa/setup', mfaSetup as unknown as RunRoute],
])('%s: step-up gate runs ahead of the rate limit', (_name, route) => {
  it('does not spend the rate limit on a request bounced for verification', async () => {
    h.findBySid.mockResolvedValue(sessionSteppedUpAt(null));

    const { error } = await route(requestFor({}), {});

    expect(error).toMatchObject({ additionalInfo: { code: 'step_up_required' } });
    expect(h.rateLimitSpy).not.toHaveBeenCalled();
    expect(h.routeHandler).not.toHaveBeenCalled();
  });

  it('does not spend the rate limit on a request with no session id', async () => {
    const { error } = await route(requestFor({ sid: undefined }), {});

    expect(error).toMatchObject({ additionalInfo: { code: 'step_up_unavailable' } });
    expect(h.rateLimitSpy).not.toHaveBeenCalled();
  });

  it('applies the rate limit once the session has stepped up', async () => {
    h.findBySid.mockResolvedValue(sessionSteppedUpAt(new Date()));

    const { error } = await route(requestFor({}), {});

    expect(error).toBeUndefined();
    expect(h.rateLimitSpy).toHaveBeenCalledTimes(1);
    expect(h.routeHandler).toHaveBeenCalledTimes(1);
  });
});
