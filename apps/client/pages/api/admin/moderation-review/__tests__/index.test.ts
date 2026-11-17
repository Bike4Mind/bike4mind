// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const m = vi.hoisted(() => ({ findModerationReviewQueue: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  userRepository: { findModerationReviewQueue: m.findModerationReviewQueue },
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    use: (guard: (req: Request, res: Response, next: () => void) => void) => ({
      get: (h: (req: Request, res: Response) => unknown) => async (req: Request, res: Response) => {
        guard(req, res, () => {});
        return h(req, res);
      },
    }),
  }),
}));

import handler from '../index';

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
    await expect(runHandler(makeReq({ isAdmin: false, adminPermissions: ['credits:adjust'] }), res)).rejects.toThrow();
    expect(m.findModerationReviewQueue).not.toHaveBeenCalled();
  });

  it('refuses an API key without the admin scope', async () => {
    const res = makeRes();
    const req = { ...makeReq({ isAdmin: true }), apiKeyInfo: { scopes: ['chat'] } };
    await expect(runHandler(req, res)).rejects.toThrow('Insufficient API key permissions');
    expect(m.findModerationReviewQueue).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range limit', async () => {
    const res = makeRes();
    await runHandler(makeReq({ isAdmin: true }, { limit: '1000' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(m.findModerationReviewQueue).not.toHaveBeenCalled();
  });
});
