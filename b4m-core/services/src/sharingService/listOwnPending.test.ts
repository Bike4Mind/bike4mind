import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { listOwnPendingInvites } from './listOwnPending';

describe('sharingService - listOwnPendingInvites', () => {
  const user = { id: 'user-1', email: 'u1@example.com' } as any;

  let db: { invites: { findAllByPendingUserIdOrEmail: Mock } };

  beforeEach(() => {
    vi.clearAllMocks();
    db = { invites: { findAllByPendingUserIdOrEmail: vi.fn() } };
  });

  it('returns the page of data plus the total count', async () => {
    // First call (count, limit 1000) returns the full set; second returns the page.
    db.invites.findAllByPendingUserIdOrEmail
      .mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
      .mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);

    const result = await listOwnPendingInvites(user, { limit: 2, page: 1 }, { db } as any);

    expect(result.total).toBe(3);
    expect(result.data).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(db.invites.findAllByPendingUserIdOrEmail).toHaveBeenNthCalledWith(1, 'user-1', { limit: 1000, page: 1 });
    expect(db.invites.findAllByPendingUserIdOrEmail).toHaveBeenNthCalledWith(2, 'user-1', { limit: 2, page: 1 });
  });

  it('returns empty data/zero total when the user has no pending invites', async () => {
    db.invites.findAllByPendingUserIdOrEmail.mockResolvedValue([]);
    const result = await listOwnPendingInvites(user, { limit: 20, page: 1 }, { db } as any);
    expect(result).toEqual({ data: [], total: 0 });
  });
});
