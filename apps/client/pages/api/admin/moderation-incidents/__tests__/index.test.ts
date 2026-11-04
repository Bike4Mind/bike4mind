// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  findPendingReview: vi.fn(),
  findStaleConfirmedCsam: vi.fn(),
  findClosed: vi.fn(),
  findByIds: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  imageModerationIncidentRepository: {
    findPendingReview: m.findPendingReview,
    findStaleConfirmedCsam: m.findStaleConfirmedCsam,
    findClosed: m.findClosed,
  },
  userRepository: { findByIds: m.findByIds },
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ get: (h: (...args: unknown[]) => unknown) => h }),
}));
vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

import handler from '../index';

const runHandler = handler as unknown as (req: unknown, res: unknown) => Promise<void>;

const makeRes = () => {
  const res: Record<string, unknown> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};
const makeReq = (query: Record<string, unknown> = {}) => ({ user: { id: 'admin-1', isAdmin: true }, query });

describe('admin/moderation-incidents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.findPendingReview.mockResolvedValue([{ _id: 'inc-1', userId: 'u1' }]);
    m.findStaleConfirmedCsam.mockResolvedValue([{ _id: 'inc-2', userId: 'u2' }]);
    m.findClosed.mockResolvedValue([{ _id: 'inc-3', userId: 'u1', reviewStatus: 'no_action' }]);
    m.findByIds.mockResolvedValue([{ id: 'u1', email: 'one@example.com' }]);
  });

  it('returns the open queue with each flagged user email, null when the account is gone', async () => {
    const res = makeRes();
    await runHandler(makeReq(), res);

    expect(m.findClosed).not.toHaveBeenCalled();
    expect(m.findByIds).toHaveBeenCalledWith(['u1', 'u2']);
    expect(res.json).toHaveBeenCalledWith({
      incidents: [{ _id: 'inc-1', userId: 'u1', userEmail: 'one@example.com' }],
      staleConfirmedCsam: [{ _id: 'inc-2', userId: 'u2', userEmail: null }],
    });
  });

  it('returns closed incidents for status=closed', async () => {
    const res = makeRes();
    await runHandler(makeReq({ status: 'closed', limit: '20' }), res);

    expect(m.findClosed).toHaveBeenCalledWith(20);
    expect(m.findPendingReview).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      incidents: [{ _id: 'inc-3', userId: 'u1', reviewStatus: 'no_action', userEmail: 'one@example.com' }],
      staleConfirmedCsam: [],
    });
  });

  it('rejects an unknown status', async () => {
    const res = makeRes();
    await runHandler(makeReq({ status: 'everything' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('refuses a non-admin', async () => {
    await expect(runHandler({ user: { id: 'u', isAdmin: false }, query: {} }, makeRes())).rejects.toThrow(
      'Admin access required'
    );
  });
});
