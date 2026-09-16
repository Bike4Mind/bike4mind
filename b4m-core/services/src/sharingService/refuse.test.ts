import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { UnprocessableEntityError } from '@bike4mind/utils';
import { refuseInvite } from './refuse';

describe('sharingService - refuseInvite (expiry)', () => {
  const userId = 'user-1';
  const inviteId = 'invite-1';

  let db: {
    invites: { findByIdAndPendingEmail: Mock; update: Mock };
    users: { findById: Mock };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db = {
      invites: { findByIdAndPendingEmail: vi.fn(), update: vi.fn() },
      users: { findById: vi.fn() },
    };
  });

  const makeInvite = (expiresAt: Date | undefined) => ({
    id: inviteId,
    remaining: 1,
    expiresAt,
    recipients: { pending: ['me@example.com'], accepted: [], refused: [] },
  });

  it('rejects redemption of an invite whose expiresAt has passed', async () => {
    db.users.findById.mockResolvedValue({ id: userId, email: 'me@example.com' });
    db.invites.findByIdAndPendingEmail.mockResolvedValue(makeInvite(new Date(Date.now() - 1000)));

    await expect(refuseInvite(userId, { id: inviteId }, { db } as any)).rejects.toThrow(UnprocessableEntityError);
    expect(db.invites.update).not.toHaveBeenCalled();
  });

  it('allows redemption of an invite whose expiresAt is in the future', async () => {
    db.users.findById.mockResolvedValue({ id: userId, email: 'me@example.com' });
    db.invites.findByIdAndPendingEmail.mockResolvedValue(makeInvite(new Date(Date.now() + 1000 * 60 * 60)));

    await refuseInvite(userId, { id: inviteId }, { db } as any);

    expect(db.invites.update).toHaveBeenCalled();
  });

  it('allows redemption of an invite with no expiresAt set', async () => {
    db.users.findById.mockResolvedValue({ id: userId, email: 'me@example.com' });
    db.invites.findByIdAndPendingEmail.mockResolvedValue(makeInvite(undefined));

    await refuseInvite(userId, { id: inviteId }, { db } as any);

    expect(db.invites.update).toHaveBeenCalled();
  });
});
