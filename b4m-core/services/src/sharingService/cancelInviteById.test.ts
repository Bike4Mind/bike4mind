import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '@bike4mind/utils';
import { InviteType } from '@bike4mind/common';
import { cancelInviteById } from './cancelInviteById';

describe('sharingService - cancelInviteById', () => {
  const user = { id: 'user-1', isAdmin: false } as any;

  let db: {
    invites: { findById: Mock; update: Mock };
    fabFiles: { shareable: { findShareAccessById: Mock } };
    sessions: { shareable: { findShareAccessById: Mock } };
    projects: { shareable: { findShareAccessById: Mock } };
    organizations: { findById: Mock };
    groups: { findById: Mock };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db = {
      invites: { findById: vi.fn(), update: vi.fn() },
      fabFiles: { shareable: { findShareAccessById: vi.fn() } },
      sessions: { shareable: { findShareAccessById: vi.fn() } },
      projects: { shareable: { findShareAccessById: vi.fn() } },
      organizations: { findById: vi.fn() },
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
    db.organizations.findById.mockResolvedValue({ id: 'org-1', userId: 'other', users: [] });

    await cancelInviteById(admin, { id: 'inv-1' }, { db } as any);

    expect(db.organizations.findById).toHaveBeenCalledWith('org-1');
    expect(db.invites.update).toHaveBeenCalled();
  });

  it('denies a plain org member from cancelling a Group invite by id (must be billing owner, org admin, or platform admin)', async () => {
    const member = { id: 'member-1', isAdmin: false } as any;
    const invite = {
      id: 'inv-1',
      type: InviteType.Group,
      documentId: 'grp-1',
      remaining: 1,
      recipients: { pending: [], accepted: [], refused: [] },
    };
    db.invites.findById.mockResolvedValue(invite);
    db.groups.findById.mockResolvedValue({ id: 'grp-1', organizationId: 'org-1' });
    db.organizations.findById.mockResolvedValue({ id: 'org-1', userId: 'other', users: [{ userId: 'member-1', permissions: ['read'] }] });

    await expect(cancelInviteById(member, { id: 'inv-1' }, { db } as any)).rejects.toThrow(ForbiddenError);
    expect(db.invites.update).not.toHaveBeenCalled();
  });

  it('lets the billing owner cancel a Group invite by id', async () => {
    const owner = { id: 'owner-1', isAdmin: false } as any;
    const invite = {
      id: 'inv-1',
      type: InviteType.Group,
      documentId: 'grp-1',
      remaining: 1,
      recipients: { pending: [], accepted: [], refused: [] },
    };
    db.invites.findById.mockResolvedValueOnce(invite).mockResolvedValueOnce({ ...invite });
    db.groups.findById.mockResolvedValue({ id: 'grp-1', organizationId: 'org-1' });
    db.organizations.findById.mockResolvedValue({ id: 'org-1', userId: 'owner-1', users: [] });

    await cancelInviteById(owner, { id: 'inv-1' }, { db } as any);

    expect(db.invites.update).toHaveBeenCalled();
  });

  it('denies a plain org member from cancelling an Organization invite by id', async () => {
    const member = { id: 'member-1', isAdmin: false } as any;
    const invite = {
      id: 'inv-1',
      type: InviteType.Organization,
      documentId: 'org-1',
      remaining: 1,
      recipients: { pending: [], accepted: [], refused: [] },
    };
    db.invites.findById.mockResolvedValue(invite);
    db.organizations.findById.mockResolvedValue({ id: 'org-1', userId: 'other', users: [{ userId: 'member-1', permissions: ['read'] }] });

    await expect(cancelInviteById(member, { id: 'inv-1' }, { db } as any)).rejects.toThrow(ForbiddenError);
    expect(db.invites.update).not.toHaveBeenCalled();
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
