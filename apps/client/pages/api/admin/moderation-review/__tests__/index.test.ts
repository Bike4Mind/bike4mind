// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const m = vi.hoisted(() => ({ findModerationReviewQueue: vi.fn(), baseApiOptions: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  userRepository: { findModerationReviewQueue: m.findModerationReviewQueue },
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    m.baseApiOptions(options);
    return {
      use: (guard: (req: Request, res: Response, next: () => void) => void) => ({
        get: (h: (req: Request, res: Response) => unknown) => async (req: Request, res: Response) => {
          guard(req, res, () => {});
          return h(req, res);
        },
      }),
    };
  },
}));

import { ForbiddenError } from '@bike4mind/common';
import handler from '../index';

// Captured at import: the route is built once, when the module loads.
const baseApiOptions = m.baseApiOptions.mock.calls[0]?.[0];

const runHandler = handler as unknown as (req: unknown, res: unknown) => Promise<void>;

const makeRes = () => {
  const res: Record<string, unknown> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};
const makeReq = (user: Record<string, unknown>, query: Record<string, unknown> = {}) => ({
  method: 'GET',
  user: { id: 'admin-1', ...user },
  query,
});

describe('admin/moderation-review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.findModerationReviewQueue.mockResolvedValue([{ id: 'u1' }]);
  });

  it('returns the review list for a full admin with the default limit', async () => {
    const res = makeRes();
    await runHandler(makeReq({ isAdmin: true }), res);

    expect(m.findModerationReviewQueue).toHaveBeenCalledWith(100);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ users: [{ id: 'u1' }] });
  });

  it.each(['support:read', 'users:moderate'])('admits a delegate holding %s', async permission => {
    const res = makeRes();
    await runHandler(makeReq({ isAdmin: false, adminPermissions: [permission] }), res);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('refuses a delegate without a moderation read permission', async () => {
    const res = makeRes();
    await expect(runHandler(makeReq({ isAdmin: false, adminPermissions: ['credits:adjust'] }), res)).rejects.toThrow(
      ForbiddenError
    );
    expect(m.findModerationReviewQueue).not.toHaveBeenCalled();
  });

  // API keys are refused by baseApi's auth, not by this handler's own check.
  it('is built for JWT sessions only', () => {
    expect(baseApiOptions).toMatchObject({ auth: 'jwtOnly', allowedMethods: ['GET'] });
  });

  it.each(['1000', '0', 'abc', '1.5'])('rejects the limit %s', async limit => {
    const res = makeRes();
    await runHandler(makeReq({ isAdmin: true }, { limit }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(m.findModerationReviewQueue).not.toHaveBeenCalled();
  });

  it('passes a valid limit through', async () => {
    const res = makeRes();
    await runHandler(makeReq({ isAdmin: true }, { limit: '25' }), res);

    expect(m.findModerationReviewQueue).toHaveBeenCalledWith(25);
  });
});
