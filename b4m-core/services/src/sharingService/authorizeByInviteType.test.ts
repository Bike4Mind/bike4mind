import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { InviteType } from '@bike4mind/common';
import { UnauthorizedError } from '@bike4mind/utils';
import { authorizeByInviteType } from './authorizeByInviteType';

describe('sharingService - authorizeByInviteType', () => {
  const user = { id: 'user-1', isAdmin: false } as any;

  let db: {
    fabFiles: { shareable: { findShareAccessById: Mock } };
    sessions: { shareable: { findShareAccessById: Mock } };
    projects: { shareable: { findShareAccessById: Mock } };
    organizations: { shareable: { findShareAccessById: Mock }; findById: Mock };
    groups: { findById: Mock };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db = {
      fabFiles: { shareable: { findShareAccessById: vi.fn() } },
      sessions: { shareable: { findShareAccessById: vi.fn() } },
      projects: { shareable: { findShareAccessById: vi.fn() } },
      organizations: { shareable: { findShareAccessById: vi.fn() }, findById: vi.fn() },
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

  it('authorizes an Organization via findById for an admin, share access otherwise', async () => {
    db.organizations.findById.mockResolvedValue({ id: 'org' });
    await authorizeByInviteType({ id: 'a', isAdmin: true } as any, InviteType.Organization, 'org', db as any);
    expect(db.organizations.findById).toHaveBeenCalledWith('org');
    expect(db.organizations.shareable.findShareAccessById).not.toHaveBeenCalled();

    vi.clearAllMocks();
    db.organizations.shareable.findShareAccessById.mockResolvedValue({ id: 'org' });
    await authorizeByInviteType(user, InviteType.Organization, 'org', db as any);
    expect(db.organizations.shareable.findShareAccessById).toHaveBeenCalledWith(user, 'org');
    expect(db.organizations.findById).not.toHaveBeenCalled();
  });

  it('authorizes a Group via its parent org share access (no admin bypass)', async () => {
    db.groups.findById.mockResolvedValue({ id: 'grp', organizationId: 'org-1' });
    db.organizations.shareable.findShareAccessById.mockResolvedValue({ id: 'org-1' });

    await authorizeByInviteType({ id: 'a', isAdmin: true } as any, InviteType.Group, 'grp', db as any);

    // even for an admin, the Group arm goes through org share access, not findById
    expect(db.organizations.shareable.findShareAccessById).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a' }),
      'org-1'
    );
    expect(db.organizations.findById).not.toHaveBeenCalled();
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
});
