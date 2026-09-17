import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { NotFoundError, UnauthorizedError, UnprocessableEntityError } from '@bike4mind/utils';
import { InviteType } from '@bike4mind/common';
import { refuseWholeInvite } from './refuseWholeInvite';

describe('sharingService - refuseWholeInvite', () => {
  const user = { id: 'user-1', email: 'me@example.com', isAdmin: false } as any;

  let db: {
    invites: { findById: Mock; findByToken: Mock; update: Mock };
    fabFiles: { shareable: { findShareAccessById: Mock } };
    sessions: { shareable: { findShareAccessById: Mock } };
    projects: { shareable: { findShareAccessById: Mock } };
    organizations: { shareable: { findShareAccessById: Mock }; findById: Mock };
    groups: { findById: Mock };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db = {
      invites: { findById: vi.fn(), findByToken: vi.fn().mockResolvedValue(null), update: vi.fn() },
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
      id: '65a1f77bcf86cd7994390001',
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

    await refuseWholeInvite(user, { id: '65a1f77bcf86cd7994390001' }, { db } as any);

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
      id: '65a1f77bcf86cd7994390001',
      type: InviteType.FabFile,
      documentId: 'doc-1',
      remaining: 1,
      recipients: { pending: ['someone-else@example.com'], accepted: [], refused: [] },
    });
    db.fabFiles.shareable.findShareAccessById.mockResolvedValue(null);

    await expect(refuseWholeInvite(user, { id: '65a1f77bcf86cd7994390001' }, { db } as any)).rejects.toThrow(
      UnauthorizedError
    );
    expect(db.invites.update).not.toHaveBeenCalled();
  });

  it('lets a share-authorized caller revoke the whole invite even though they are not a named recipient', async () => {
    const invite = {
      id: '65a1f77bcf86cd7994390001',
      type: InviteType.FabFile,
      documentId: 'doc-1',
      remaining: 3,
      recipients: { pending: ['a@example.com', 'b@example.com'], accepted: [], refused: [] },
    };
    db.invites.findById.mockResolvedValueOnce(invite).mockResolvedValueOnce({ ...invite });
    db.fabFiles.shareable.findShareAccessById.mockResolvedValue({ id: 'doc-1' });

    await refuseWholeInvite(user, { id: '65a1f77bcf86cd7994390001' }, { db } as any);

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
      id: '65a1f77bcf86cd7994390001',
      type: InviteType.FabFile,
      documentId: 'doc-1',
      remaining: 1,
      recipients: { pending: [], accepted: [], refused: [] },
    });
    db.fabFiles.shareable.findShareAccessById.mockResolvedValue(null);

    await expect(refuseWholeInvite(user, { id: '65a1f77bcf86cd7994390001' }, { db } as any)).rejects.toThrow(
      UnauthorizedError
    );
    expect(db.invites.update).not.toHaveBeenCalled();
  });

  // The tokenized shape, revoked by `_id`: this is how the document's invite list addresses it, and
  // the redeemable door would 404 it. Refuse is authorized by share authority here, never by holding
  // the key, so the id is an address and the sharer revoking their own link must still work.
  it('lets a share-authorized caller revoke a TOKENIZED link invite by its _id', async () => {
    const invite = {
      id: '65a1f77bcf86cd7994390001',
      token: 'wVvJ0hEr1sKq7nQ9YpB2fL4dXz8TcMuGaSiN3ROZjkw',
      type: InviteType.FabFile,
      documentId: 'doc-1',
      isLinkOnly: true,
      remaining: 1,
      recipients: { pending: [], accepted: [], refused: [] },
    };
    db.invites.findById.mockResolvedValueOnce(invite).mockResolvedValueOnce({ ...invite });
    db.fabFiles.shareable.findShareAccessById.mockResolvedValue({ id: 'doc-1' });

    await refuseWholeInvite(user, { id: '65a1f77bcf86cd7994390001' }, { db } as any);

    expect(db.invites.update).toHaveBeenCalledWith(expect.objectContaining({ remaining: 0 }));
  });

  // The other half of the same pair: the id opening this door grants nothing on its own.
  it('still denies a keyholder without share authority on that same tokenized link invite', async () => {
    db.invites.findById.mockResolvedValue({
      id: '65a1f77bcf86cd7994390001',
      token: 'wVvJ0hEr1sKq7nQ9YpB2fL4dXz8TcMuGaSiN3ROZjkw',
      type: InviteType.FabFile,
      documentId: 'doc-1',
      isLinkOnly: true,
      remaining: 1,
      recipients: { pending: [], accepted: [], refused: [] },
    });
    db.fabFiles.shareable.findShareAccessById.mockResolvedValue(null);

    await expect(refuseWholeInvite(user, { id: '65a1f77bcf86cd7994390001' }, { db } as any)).rejects.toThrow(
      UnauthorizedError
    );
    expect(db.invites.update).not.toHaveBeenCalled();
  });

  it('lets a share-authorized caller revoke a legacy tokenless link invite (no pending list)', async () => {
    const invite = {
      id: '65a1f77bcf86cd7994390001',
      type: InviteType.FabFile,
      documentId: 'doc-1',
      remaining: 1,
      recipients: { pending: [], accepted: [], refused: [] },
    };
    db.invites.findById.mockResolvedValueOnce(invite).mockResolvedValueOnce({ ...invite });
    db.fabFiles.shareable.findShareAccessById.mockResolvedValue({ id: 'doc-1' });

    await refuseWholeInvite(user, { id: '65a1f77bcf86cd7994390001' }, { db } as any);

    expect(db.invites.update).toHaveBeenCalledWith(expect.objectContaining({ remaining: 0 }));
  });

  it('throws NotFoundError when the invite does not exist', async () => {
    db.invites.findById.mockResolvedValue(null);
    await expect(refuseWholeInvite(user, { id: 'missing' }, { db } as any)).rejects.toThrow(NotFoundError);
  });

  it('rejects an expired invite even for a named pending recipient', async () => {
    db.invites.findById.mockResolvedValue({
      id: '65a1f77bcf86cd7994390001',
      type: InviteType.FabFile,
      documentId: 'doc-1',
      remaining: 1,
      expiresAt: new Date(Date.now() - 1000),
      recipients: { pending: ['me@example.com'], accepted: [], refused: [] },
    });

    await expect(refuseWholeInvite(user, { id: '65a1f77bcf86cd7994390001' }, { db } as any)).rejects.toThrow(
      UnprocessableEntityError
    );
    expect(db.invites.update).not.toHaveBeenCalled();
  });

  /**
   * Refuse is reached from two surfaces that hold different keys. The inbox lists invites through a
   * projection carrying no token, so it can only address them by `_id`; the share page passes
   * whatever is in the URL, which for any invite minted since the token cutover is the token. Both
   * have to work, or the Refuse button 404s on one of them.
   */
  describe('addressing: the key can be the token or the id', () => {
    const TOKEN = 'wVvJ0hEr1sKq7nQ9YpB2fL4dXz8TcMuGaSiN3ROZjkw';
    const ID = '65a1f77bcf86cd7994390001';

    const tokenizedNamedInvite = () => ({
      id: ID,
      token: TOKEN,
      type: InviteType.FabFile,
      documentId: 'doc-1',
      isLinkOnly: false,
      remaining: 2,
      recipients: { pending: ['me@example.com', 'other@example.com'], accepted: [], refused: [] },
    });

    // The reported regression: a recipient clicking Refuse on the link from their email.
    it('declines by token, as the share page addresses it', async () => {
      const invite = tokenizedNamedInvite();
      db.invites.findByToken.mockResolvedValue(invite);

      await refuseWholeInvite(user, { id: TOKEN }, { db } as any);

      expect(db.invites.update).toHaveBeenCalledWith(
        expect.objectContaining({
          remaining: 1,
          recipients: expect.objectContaining({ pending: ['other@example.com'] }),
        })
      );
    });

    // The same regression from the other side: closing the id door for every tokenized invite would
    // have broken this one, which no UI can address any other way.
    it('declines by id, as the inbox addresses it', async () => {
      const invite = tokenizedNamedInvite();
      db.invites.findById.mockResolvedValueOnce(invite).mockResolvedValueOnce({ ...invite });

      await refuseWholeInvite(user, { id: ID }, { db } as any);

      expect(db.invites.update).toHaveBeenCalledWith(
        expect.objectContaining({
          remaining: 1,
          recipients: expect.objectContaining({ pending: ['other@example.com'] }),
        })
      );
    });
  });
});
