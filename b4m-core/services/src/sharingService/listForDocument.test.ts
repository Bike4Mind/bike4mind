import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { UnauthorizedError } from '@bike4mind/utils';
import { InviteType } from '@bike4mind/common';
import { listInvitesForDocument } from './listForDocument';

describe('sharingService - listInvitesForDocument', () => {
  const user = { id: 'user-1', isAdmin: false } as any;
  const documentId = 'doc-1';

  let db: {
    invites: { findAllByDocumentId: Mock };
    fabFiles: { shareable: { findShareAccessById: Mock } };
    sessions: { shareable: { findShareAccessById: Mock } };
    projects: { shareable: { findShareAccessById: Mock } };
    organizations: { shareable: { findShareAccessById: Mock }; findById: Mock };
    groups: { findById: Mock };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db = {
      invites: { findAllByDocumentId: vi.fn() },
      fabFiles: { shareable: { findShareAccessById: vi.fn() } },
      sessions: { shareable: { findShareAccessById: vi.fn() } },
      projects: { shareable: { findShareAccessById: vi.fn() } },
      organizations: { shareable: { findShareAccessById: vi.fn() }, findById: vi.fn() },
      groups: { findById: vi.fn() },
    };
  });

  it('returns invites for the document (filtered by type) when the caller has share access to a FabFile', async () => {
    db.fabFiles.shareable.findShareAccessById.mockResolvedValue({ id: documentId });
    db.invites.findAllByDocumentId.mockResolvedValue([
      { id: 'i1', documentId, type: InviteType.FabFile },
      { id: 'i2', documentId, type: InviteType.Session }, // different type -> filtered out
    ]);

    const result = await listInvitesForDocument(user, { documentId, type: InviteType.FabFile }, { db } as any);

    expect(db.fabFiles.shareable.findShareAccessById).toHaveBeenCalledWith(user, documentId);
    expect(result).toEqual([{ id: 'i1', documentId, type: InviteType.FabFile }]);
  });

  it('denies a caller without share access (findShareAccessById returns null)', async () => {
    db.sessions.shareable.findShareAccessById.mockResolvedValue(null);

    await expect(listInvitesForDocument(user, { documentId, type: InviteType.Session }, { db } as any)).rejects.toThrow(
      UnauthorizedError
    );
    expect(db.invites.findAllByDocumentId).not.toHaveBeenCalled();
  });

  it('authorizes a Group via its organization share access', async () => {
    db.groups.findById.mockResolvedValue({ id: documentId, organizationId: 'org-1' });
    db.organizations.shareable.findShareAccessById.mockResolvedValue({ id: 'org-1' });
    db.invites.findAllByDocumentId.mockResolvedValue([{ id: 'i3', documentId, type: InviteType.Group }]);

    const result = await listInvitesForDocument(user, { documentId, type: InviteType.Group }, { db } as any);

    expect(db.organizations.shareable.findShareAccessById).toHaveBeenCalledWith(user, 'org-1');
    expect(result).toHaveLength(1);
  });

  it('denies a Group when the parent organization is not share-accessible', async () => {
    db.groups.findById.mockResolvedValue({ id: documentId, organizationId: 'org-1' });
    db.organizations.shareable.findShareAccessById.mockResolvedValue(null);

    await expect(listInvitesForDocument(user, { documentId, type: InviteType.Group }, { db } as any)).rejects.toThrow(
      UnauthorizedError
    );
  });

  it('authorizes an Organization invite for an admin via findById', async () => {
    const admin = { id: 'admin-1', isAdmin: true } as any;
    db.organizations.findById.mockResolvedValue({ id: documentId });
    db.invites.findAllByDocumentId.mockResolvedValue([{ id: 'i9', documentId, type: InviteType.Organization }]);

    const result = await listInvitesForDocument(admin, { documentId, type: InviteType.Organization }, { db } as any);

    expect(db.organizations.findById).toHaveBeenCalledWith(documentId);
    expect(db.organizations.shareable.findShareAccessById).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
  });

  it('denies a Group whose parent group is missing', async () => {
    db.groups.findById.mockResolvedValue(null);

    await expect(listInvitesForDocument(user, { documentId, type: InviteType.Group }, { db } as any)).rejects.toThrow(
      UnauthorizedError
    );
    expect(db.invites.findAllByDocumentId).not.toHaveBeenCalled();
  });

  it('returns an empty array when the document has no invites of that type', async () => {
    db.sessions.shareable.findShareAccessById.mockResolvedValue({ id: documentId });
    db.invites.findAllByDocumentId.mockResolvedValue([]);

    const result = await listInvitesForDocument(user, { documentId, type: InviteType.Session }, { db } as any);
    expect(result).toEqual([]);
  });
});
