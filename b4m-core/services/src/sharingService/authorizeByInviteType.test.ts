import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { InviteType } from '@bike4mind/common';
import { ForbiddenError, UnauthorizedError } from '@bike4mind/utils';
import { authorizeByInviteType } from './authorizeByInviteType';

describe('sharingService - authorizeByInviteType', () => {
  const user = { id: 'user-1', isAdmin: false } as any;

  let db: {
    fabFiles: { shareable: { findShareAccessById: Mock } };
    sessions: { shareable: { findShareAccessById: Mock } };
    projects: { shareable: { findShareAccessById: Mock } };
    organizations: { findById: Mock };
    groups: { findById: Mock };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db = {
      fabFiles: { shareable: { findShareAccessById: vi.fn() } },
      sessions: { shareable: { findShareAccessById: vi.fn() } },
      projects: { shareable: { findShareAccessById: vi.fn() } },
      organizations: { findById: vi.fn() },
      groups: { findById: vi.fn() },
    };
  });

  it('authorizes FabFile / Session / Project via their share access (resolves without throwing)', async () => {
    for (const [type, repo] of [
      [InviteType.FabFile, db.fabFiles],
      [InviteType.Session, db.sessions],
      [InviteType.Project, db.projects],
    ] as const) {
      repo.shareable.findShareAccessById.mockResolvedValue({ id: 'doc' });
      await expect(authorizeByInviteType(user, type, 'doc', db as any)).resolves.toBeUndefined();
      expect(repo.shareable.findShareAccessById).toHaveBeenCalledWith(user, 'doc');
    }
  });

  it('authorizes an Organization via findById + membership check (billing owner, member, or admin)', async () => {
    const org = { id: 'org', userId: 'owner', users: [{ userId: 'member-1', permissions: ['read'] }] };

    // billing owner
    db.organizations.findById.mockResolvedValue(org);
    await authorizeByInviteType({ id: 'owner', isAdmin: false } as any, InviteType.Organization, 'org', db as any);
    expect(db.organizations.findById).toHaveBeenCalledWith('org');

    // users[] member
    vi.clearAllMocks();
    db.organizations.findById.mockResolvedValue(org);
    await authorizeByInviteType({ id: 'member-1', isAdmin: false } as any, InviteType.Organization, 'org', db as any);
    expect(db.organizations.findById).toHaveBeenCalledWith('org');

    // platform admin bypasses membership
    vi.clearAllMocks();
    db.organizations.findById.mockResolvedValue(org);
    await authorizeByInviteType({ id: 'x', isAdmin: true } as any, InviteType.Organization, 'org', db as any);
    expect(db.organizations.findById).toHaveBeenCalledWith('org');
  });

  it('denies an Organization caller not in the org', async () => {
    const org = { id: 'org', userId: 'owner', users: [] };
    db.organizations.findById.mockResolvedValue(org);

    await expect(authorizeByInviteType({ id: 'outsider', isAdmin: false } as any, InviteType.Organization, 'org', db as any)).rejects.toThrow(UnauthorizedError);
  });

  it('authorizes a Group via findById + membership on its parent org', async () => {
    const org = { id: 'org-1', userId: 'owner', users: [{ userId: 'a', permissions: ['read'] }] };
    db.groups.findById.mockResolvedValue({ id: 'grp', organizationId: 'org-1' });
    db.organizations.findById.mockResolvedValue(org);

    // member of the parent org
    await authorizeByInviteType({ id: 'a', isAdmin: false } as any, InviteType.Group, 'grp', db as any);
    expect(db.organizations.findById).toHaveBeenCalledWith('org-1');

    // platform admin also passes
    vi.clearAllMocks();
    db.groups.findById.mockResolvedValue({ id: 'grp', organizationId: 'org-1' });
    db.organizations.findById.mockResolvedValue({ id: 'org-1', userId: 'owner', users: [{ userId: 'a', permissions: ['read'] }] });
    await authorizeByInviteType({ id: 'x', isAdmin: true } as any, InviteType.Group, 'grp', db as any);
    expect(db.organizations.findById).toHaveBeenCalledWith('org-1');
  });

  it('denies a Group whose parent group is missing', async () => {
    db.groups.findById.mockResolvedValue(null);
    await expect(authorizeByInviteType(user, InviteType.Group, 'grp', db as any)).rejects.toThrow(UnauthorizedError);
  });

  it('denies an unsupported invite type (Tool has no auth arm)', async () => {
    await expect(authorizeByInviteType(user, InviteType.Tool, 'doc', db as any)).rejects.toThrow(UnauthorizedError);
    expect(db.fabFiles.shareable.findShareAccessById).not.toHaveBeenCalled();
  });

  it('denies when the per-type share lookup returns null', async () => {
    db.sessions.shareable.findShareAccessById.mockResolvedValue(null);
    await expect(authorizeByInviteType(user, InviteType.Session, 'doc', db as any)).rejects.toThrow(UnauthorizedError);
  });

  describe('requireManageGroups option', () => {
    const org = { id: 'org', userId: 'owner', adminUserIds: [], users: [{ userId: 'member-1', permissions: ['read'] }] };

    it('denies a plain org member on Organization when requireManageGroups is true', async () => {
      db.organizations.findById.mockResolvedValue(org);
      await expect(
        authorizeByInviteType({ id: 'member-1', isAdmin: false } as any, InviteType.Organization, 'org', db as any, { requireManageGroups: true })
      ).rejects.toThrow(ForbiddenError);
    });

    it('lets the billing owner through on Organization when requireManageGroups is true', async () => {
      db.organizations.findById.mockResolvedValue(org);
      await expect(
        authorizeByInviteType({ id: 'owner', isAdmin: false } as any, InviteType.Organization, 'org', db as any, { requireManageGroups: true })
      ).resolves.toBeUndefined();
    });

    it('denies a plain org member on Group when requireManageGroups is true', async () => {
      db.groups.findById.mockResolvedValue({ id: 'grp', organizationId: 'org' });
      db.organizations.findById.mockResolvedValue(org);
      await expect(
        authorizeByInviteType({ id: 'member-1', isAdmin: false } as any, InviteType.Group, 'grp', db as any, { requireManageGroups: true })
      ).rejects.toThrow(ForbiddenError);
    });

    it('lets the billing owner through on Group when requireManageGroups is true', async () => {
      db.groups.findById.mockResolvedValue({ id: 'grp', organizationId: 'org' });
      db.organizations.findById.mockResolvedValue(org);
      await expect(
        authorizeByInviteType({ id: 'owner', isAdmin: false } as any, InviteType.Group, 'grp', db as any, { requireManageGroups: true })
      ).resolves.toBeUndefined();
    });

    it('still allows a plain member to list (requireManageGroups absent) on Organization', async () => {
      db.organizations.findById.mockResolvedValue(org);
      await expect(
        authorizeByInviteType({ id: 'member-1', isAdmin: false } as any, InviteType.Organization, 'org', db as any)
      ).resolves.toBeUndefined();
    });
  });
});
