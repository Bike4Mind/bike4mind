import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { ForbiddenError, NotFoundError } from '@bike4mind/utils';
import { refuseWholeInvite } from './refuseWholeInvite';

describe('sharingService - refuseWholeInvite', () => {
  const userId = 'user-1';
  const recipient = { id: userId, email: 'me@example.com' };

  let db: {
    invites: { findById: Mock; update: Mock };
    users: { findById: Mock };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db = {
      invites: { findById: vi.fn(), update: vi.fn() },
      users: { findById: vi.fn().mockResolvedValue(recipient) },
    };
  });

  it('refuses the whole invite for a pending recipient (zeroes remaining, clears pending, records refused)', async () => {
    const invite = {
      id: 'inv-1',
      remaining: 3,
      recipients: { pending: ['me@example.com'], accepted: [], refused: [] },
    };
    db.invites.findById.mockResolvedValueOnce(invite).mockResolvedValueOnce({ ...invite });

    await refuseWholeInvite(userId, { id: 'inv-1' }, { db } as any);

    expect(db.invites.update).toHaveBeenCalledWith(
      expect.objectContaining({
        remaining: 0,
        recipients: { pending: [], accepted: [], refused: ['me@example.com'] },
      })
    );
  });

  it('denies a non-recipient on an email invite (the auth hole the manager left open)', async () => {
    db.invites.findById.mockResolvedValue({
      id: 'inv-1',
      remaining: 1,
      recipients: { pending: ['someone-else@example.com'], accepted: [], refused: [] },
    });

    await expect(refuseWholeInvite(userId, { id: 'inv-1' }, { db } as any)).rejects.toThrow(ForbiddenError);
    expect(db.invites.update).not.toHaveBeenCalled();
  });

  it('allows an isPublic refuse regardless of the pending list', async () => {
    const invite = {
      id: 'inv-1',
      remaining: 1,
      recipients: { pending: ['other@example.com'], accepted: [], refused: [] },
    };
    db.invites.findById.mockResolvedValueOnce(invite).mockResolvedValueOnce({ ...invite });

    await refuseWholeInvite(userId, { id: 'inv-1', isPublic: true }, { db } as any);
    expect(db.invites.update).toHaveBeenCalled();
  });

  it('allows refusing a link invite (no pending list) by anyone', async () => {
    const invite = { id: 'inv-1', remaining: 1, recipients: { pending: [], accepted: [], refused: [] } };
    db.invites.findById.mockResolvedValueOnce(invite).mockResolvedValueOnce({ ...invite });

    await refuseWholeInvite(userId, { id: 'inv-1' }, { db } as any);
    expect(db.invites.update).toHaveBeenCalled();
  });

  it('throws NotFoundError when the invite does not exist', async () => {
    db.invites.findById.mockResolvedValue(null);
    await expect(refuseWholeInvite(userId, { id: 'missing' }, { db } as any)).rejects.toThrow(NotFoundError);
  });
});
