import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { NotFoundError, UnauthorizedError } from '@bike4mind/utils';
import { InviteType } from '@bike4mind/common';
import { cancelInviteById } from './cancelInviteById';

describe('sharingService - cancelInviteById', () => {
  const user = { id: 'user-1', isAdmin: false } as any;

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

  it('cancels a FabFile invite for a share-authorized caller (remaining=0, pending cleared, refused kept)', async () => {
    const invite = {
      id: 'inv-1',
      type: InviteType.FabFile,
      documentId: 'doc-1',
      remaining: 2,
      recipients: { pending: ['x@example.com'], accepted: [], refused: ['gone@example.com'] },
    };
    db.invites.findById.mockResolvedValueOnce(invite).mockResolvedValueOnce({ ...invite });
    db.fabFiles.shareable.findShareAccessById.mockResolvedValue({ id: 'doc-1' });

    await cancelInviteById(user, { id: 'inv-1' }, { db } as any);

    expect(db.fabFiles.shareable.findShareAccessById).toHaveBeenCalledWith(user, 'doc-1');
    expect(db.invites.update).toHaveBeenCalledWith(
      expect.objectContaining({
        remaining: 0,
        recipients: { pending: [], accepted: [], refused: ['gone@example.com'] },
      })
    );
  });

  it('denies a caller without share access to the document', async () => {
    db.invites.findById.mockResolvedValue({
      id: 'inv-1',
      type: InviteType.Session,
      documentId: 'doc-1',
      remaining: 1,
      recipients: {},
    });
    db.sessions.shareable.findShareAccessById.mockResolvedValue(null);

    await expect(cancelInviteById(user, { id: 'inv-1' }, { db } as any)).rejects.toThrow(UnauthorizedError);
    expect(db.invites.update).not.toHaveBeenCalled();
  });

  it('authorizes an Organization invite for an admin via findById', async () => {
    const admin = { id: 'admin-1', isAdmin: true } as any;
    const invite = {
      id: 'inv-1',
      type: InviteType.Organization,
      documentId: 'org-1',
      remaining: 1,
      recipients: { pending: [], accepted: [], refused: [] },
    };
    db.invites.findById.mockResolvedValueOnce(invite).mockResolvedValueOnce({ ...invite });
    db.organizations.findById.mockResolvedValue({ id: 'org-1' });

    await cancelInviteById(admin, { id: 'inv-1' }, { db } as any);

    expect(db.organizations.findById).toHaveBeenCalledWith('org-1');
    expect(db.organizations.shareable.findShareAccessById).not.toHaveBeenCalled();
    expect(db.invites.update).toHaveBeenCalled();
  });

  it('authorizes a Group invite via the parent organization share access (no admin bypass)', async () => {
    const invite = {
      id: 'inv-1',
      type: InviteType.Group,
      documentId: 'grp-1',
      remaining: 1,
      recipients: { pending: [], accepted: [], refused: [] },
    };
    db.invites.findById.mockResolvedValueOnce(invite).mockResolvedValueOnce({ ...invite });
    db.groups.findById.mockResolvedValue({ id: 'grp-1', organizationId: 'org-1' });
    db.organizations.shareable.findShareAccessById.mockResolvedValue({ id: 'org-1' });

    await cancelInviteById(user, { id: 'inv-1' }, { db } as any);

    expect(db.organizations.shareable.findShareAccessById).toHaveBeenCalledWith(user, 'org-1');
    expect(db.invites.update).toHaveBeenCalled();
  });

  it('denies a Group invite whose parent group is missing', async () => {
    db.invites.findById.mockResolvedValue({
      id: 'inv-1',
      type: InviteType.Group,
      documentId: 'grp-gone',
      remaining: 1,
      recipients: {},
    });
    db.groups.findById.mockResolvedValue(null);

    await expect(cancelInviteById(user, { id: 'inv-1' }, { db } as any)).rejects.toThrow(UnauthorizedError);
    expect(db.invites.update).not.toHaveBeenCalled();
  });

  it('throws NotFoundError when the invite does not exist', async () => {
    db.invites.findById.mockResolvedValue(null);
    await expect(cancelInviteById(user, { id: 'missing' }, { db } as any)).rejects.toThrow(NotFoundError);
  });
});
