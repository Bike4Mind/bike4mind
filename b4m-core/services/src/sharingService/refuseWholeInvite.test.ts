import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { NotFoundError, UnauthorizedError, UnprocessableEntityError } from '@bike4mind/utils';
import { InviteType } from '@bike4mind/common';
import { refuseWholeInvite } from './refuseWholeInvite';

describe('sharingService - refuseWholeInvite', () => {
  const user = { id: 'user-1', email: 'me@example.com', isAdmin: false } as any;

  let db: {
    invites: { findById: Mock; update: Mock };
    fabFiles: { shareable: { findShareAccessById: Mock } };
    sessions: { shareable: { findShareAccessById: Mock } };
    projects: { shareable: { findShareAccessById: Mock } };
    organizations: { shareable: { findShareAccessById: Mock }; findById: Mock };
    groups: { findById: Mock };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db = {
      invites: { findById: vi.fn(), update: vi.fn() },
      fabFiles: { shareable: { findShareAccessById: vi.fn() } },
      sessions: { shareable: { findShareAccessById: vi.fn() } },
      projects: { shareable: { findShareAccessById: vi.fn() } },
      organizations: { shareable: { findShareAccessById: vi.fn() }, findById: vi.fn() },
      groups: { findById: vi.fn() },
    };
  });

  it("declining as a named recipient touches ONLY the caller's own slot, leaving co-recipients and the invite's remaining count intact", async () => {
    // This is the exact defect: one recipient declining previously zeroed `remaining`
    // and cleared `pending` for EVERY recipient, not just the caller.
    const invite = {
      id: 'inv-1',
      type: InviteType.FabFile,
      documentId: 'doc-1',
      remaining: 2,
      recipients: {
        pending: ['me@example.com', 'other@example.com'],
        accepted: [],
        refused: ['already-refused@example.com'],
      },
    };
    db.invites.findById.mockResolvedValueOnce(invite).mockResolvedValueOnce({ ...invite });

    await refuseWholeInvite(user, { id: 'inv-1' }, { db } as any);

    expect(db.invites.update).toHaveBeenCalledWith(
      expect.objectContaining({
        remaining: 1,
        recipients: {
          pending: ['other@example.com'],
          accepted: [],
          refused: ['already-refused@example.com', 'me@example.com'],
        },
      })
    );
    expect(db.fabFiles.shareable.findShareAccessById).not.toHaveBeenCalled();
  });

  it('denies a non-recipient without share authority on the underlying document', async () => {
    db.invites.findById.mockResolvedValue({
      id: 'inv-1',
      type: InviteType.FabFile,
      documentId: 'doc-1',
      remaining: 1,
      recipients: { pending: ['someone-else@example.com'], accepted: [], refused: [] },
    });
    db.fabFiles.shareable.findShareAccessById.mockResolvedValue(null);

    await expect(refuseWholeInvite(user, { id: 'inv-1' }, { db } as any)).rejects.toThrow(UnauthorizedError);
    expect(db.invites.update).not.toHaveBeenCalled();
  });

  it('lets a share-authorized caller revoke the whole invite even though they are not a named recipient', async () => {
    const invite = {
      id: 'inv-1',
      type: InviteType.FabFile,
      documentId: 'doc-1',
      remaining: 3,
      recipients: { pending: ['a@example.com', 'b@example.com'], accepted: [], refused: [] },
    };
    db.invites.findById.mockResolvedValueOnce(invite).mockResolvedValueOnce({ ...invite });
    db.fabFiles.shareable.findShareAccessById.mockResolvedValue({ id: 'doc-1' });

    await refuseWholeInvite(user, { id: 'inv-1' }, { db } as any);

    expect(db.fabFiles.shareable.findShareAccessById).toHaveBeenCalledWith(user, 'doc-1');
    expect(db.invites.update).toHaveBeenCalledWith(
      expect.objectContaining({
        remaining: 0,
        recipients: expect.objectContaining({ pending: [] }),
      })
    );
  });

  it('denies a random holder of a link invite id who lacks share authority (the other half of the defect)', async () => {
    db.invites.findById.mockResolvedValue({
      id: 'inv-1',
      type: InviteType.FabFile,
      documentId: 'doc-1',
      remaining: 1,
      recipients: { pending: [], accepted: [], refused: [] },
    });
    db.fabFiles.shareable.findShareAccessById.mockResolvedValue(null);

    await expect(refuseWholeInvite(user, { id: 'inv-1' }, { db } as any)).rejects.toThrow(UnauthorizedError);
    expect(db.invites.update).not.toHaveBeenCalled();
  });

  it('lets a share-authorized caller revoke a link invite (no pending list)', async () => {
    const invite = {
      id: 'inv-1',
      type: InviteType.FabFile,
      documentId: 'doc-1',
      remaining: 1,
      recipients: { pending: [], accepted: [], refused: [] },
    };
    db.invites.findById.mockResolvedValueOnce(invite).mockResolvedValueOnce({ ...invite });
    db.fabFiles.shareable.findShareAccessById.mockResolvedValue({ id: 'doc-1' });

    await refuseWholeInvite(user, { id: 'inv-1' }, { db } as any);

    expect(db.invites.update).toHaveBeenCalledWith(expect.objectContaining({ remaining: 0 }));
  });

  it('throws NotFoundError when the invite does not exist', async () => {
    db.invites.findById.mockResolvedValue(null);
    await expect(refuseWholeInvite(user, { id: 'missing' }, { db } as any)).rejects.toThrow(NotFoundError);
  });

  it('rejects an expired invite even for a named pending recipient', async () => {
    db.invites.findById.mockResolvedValue({
      id: 'inv-1',
      type: InviteType.FabFile,
      documentId: 'doc-1',
      remaining: 1,
      expiresAt: new Date(Date.now() - 1000),
      recipients: { pending: ['me@example.com'], accepted: [], refused: [] },
    });

    await expect(refuseWholeInvite(user, { id: 'inv-1' }, { db } as any)).rejects.toThrow(UnprocessableEntityError);
    expect(db.invites.update).not.toHaveBeenCalled();
  });
});
